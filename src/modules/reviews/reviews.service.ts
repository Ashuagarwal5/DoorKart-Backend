import type { Prisma } from '../../generated/prisma/client.js';
import { AppError, conflict, forbidden, notFound } from '../../lib/errors.js';
import { pageArgs, pageResult, type PageParams } from '../../lib/pagination.js';
import { prisma, type TransactionClient } from '../../lib/prisma.js';
import { emitReviewDecision } from '../notifications/emitters.js';
import { readSettings } from '../settings/settings.service.js';
import type { AdminQuery, PublicQuery, ReviewInput } from './reviews.schemas.js';

const include = { product: { select: { name: true } }, purchaseItem: { include: { order: { select: { accountId: true, orderStatus: true, paymentStatus: true, deliveredAt: true } } } } } satisfies Prisma.ReviewInclude;
type Row = Prisma.ReviewGetPayload<{ include: typeof include }>;

export async function reviewPolicy() {
  const settings = await readSettings();
  return {
    enabled: settings.text('reviews.enabled') !== 'false', verifiedOnly: settings.text('reviews.verifiedOnly') !== 'false',
    requireApproval: settings.text('reviews.requireApproval') !== 'false', allowEditing: settings.text('reviews.allowEditing') !== 'false',
    requireCollectedPayment: settings.text('reviews.requireCollectedPayment') === 'true',
    purchaseWindowDays: Number(settings.text('reviews.purchaseWindowDays')) || 0,
    editWindowDays: Number(settings.text('reviews.editWindowDays')) || 0,
    maxContentLength: Number(settings.text('reviews.maxContentLength')) || 2000,
  };
}
type Policy = Awaited<ReturnType<typeof reviewPolicy>>;
function assertEnabled(policy: Policy) {
  if (!policy.enabled) throw new AppError(403, 'REVIEWS_DISABLED', 'Product reviews are currently disabled.');
}
function assertLength(input: ReviewInput, policy: Policy) {
  if (input.content.length > policy.maxContentLength) throw new AppError(400, 'VALIDATION_ERROR', `Review content must be at most ${policy.maxContentLength} characters.`);
}
function withinEditWindow(row: Row, policy: Policy, now = new Date()) {
  return !row.deletedAt && (policy.editWindowDays === 0 || now.getTime() - row.createdAt.getTime() <= policy.editWindowDays * 86400000);
}
function verified(row: Row, policy: Policy): boolean {
  const item = row.purchaseItem;
  return row.origin === 'CUSTOMER' && row.accountId !== null && item !== null && item.productId === row.productId &&
    item.order.accountId === row.accountId && item.order.orderStatus === 'DELIVERED' && item.order.deliveredAt !== null &&
    (!policy.requireCollectedPayment || item.order.paymentStatus === 'COLLECTED');
}
function dto(row: Row, policy: Policy) {
  return { id: row.id, productId: row.productId, productName: row.product.name, rating: row.rating, title: row.title,
    content: row.content, reviewerName: row.reviewerName, origin: row.origin, sourceLabel: row.sourceLabel,
    verifiedPurchase: verified(row, policy), status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt };
}
function ownDto(row: Row, policy: Policy) {
  return { ...dto(row, policy), moderationNote: row.moderationNote,
    canEdit: policy.enabled && policy.allowEditing && withinEditWindow(row, policy), canDelete: withinEditWindow(row, policy) };
}
async function productExists(productId: string, active = true) {
  const product = await prisma.product.findFirst({ where: { id: productId, ...(active ? { isActive: true, category: { isActive: true } } : {}) }, select: { id: true, name: true } });
  if (!product) throw notFound('PRODUCT_NOT_FOUND', 'This product is not available.');
  return product;
}
async function purchase(tx: TransactionClient, productId: string, accountId: string, policy: Policy) {
  return tx.orderItem.findFirst({ where: { productId, order: { accountId, orderStatus: 'DELIVERED', deliveredAt: {
    not: null, ...(policy.purchaseWindowDays ? { gte: new Date(Date.now() - policy.purchaseWindowDays * 86400000) } : {}),
  }, ...(policy.requireCollectedPayment ? { paymentStatus: 'COLLECTED' } : {}) } }, orderBy: [{ order: { deliveredAt: 'desc' } }, { id: 'asc' }], select: { id: true } });
}
const deliveredFilter = (policy: Policy): Prisma.ReviewWhereInput => ({ origin: 'CUSTOMER', accountId: { not: null }, purchaseItem: { is: { order: { accountId: { not: null }, orderStatus: 'DELIVERED', deliveredAt: { not: null }, ...(policy.requireCollectedPayment ? { paymentStatus: 'COLLECTED' } : {}) } } } });

export async function publicReviews(productId: string, query: PublicQuery) {
  await productExists(productId);
  const policy = await reviewPolicy();
  const zero = { average: 0, count: 0, distribution: [5, 4, 3, 2, 1].map((rating) => ({ rating, count: 0 })), originCounts: { CUSTOMER: 0, ADMIN_ENTERED: 0, IMPORTED: 0 } };
  if (!policy.enabled) return { enabled: false, summary: zero, ...pageResult([], 0, query) };
  const where: Prisma.ReviewWhereInput = { productId, status: 'PUBLISHED', deletedAt: null,
    ...(policy.verifiedOnly ? { OR: [{ origin: { in: ['ADMIN_ENTERED', 'IMPORTED'] } }, deliveredFilter(policy)] } : {}) };
  const orderBy: Prisma.ReviewOrderByWithRelationInput[] = query.sort === 'recent'
    ? [{ createdAt: 'desc' }, { id: 'desc' }] : [{ rating: query.sort === 'highest' ? 'desc' : 'asc' }, { createdAt: 'desc' }, { id: 'desc' }];
  return prisma.$transaction(async (tx) => {
    const groups = await tx.review.groupBy({ by: ['rating', 'origin'], where, _count: { _all: true } });
    const summary = zero;
    let sum = 0;
    for (const group of groups) {
      summary.count += group._count._all; sum += group.rating * group._count._all;
      summary.originCounts[group.origin] += group._count._all;
      const bucket = summary.distribution.find((entry) => entry.rating === group.rating);
      if (bucket) bucket.count += group._count._all;
    }
    summary.average = summary.count ? Math.round(sum / summary.count * 100) / 100 : 0;
    const rows = await tx.review.findMany({ where, include, orderBy, ...pageArgs(query) });
    return { enabled: true, summary, ...pageResult(rows.map((row) => dto(row, policy)), summary.count, query) };
  }, { isolationLevel: 'RepeatableRead' });
}

export async function reviewEligibility(productId: string, accountId: string) {
  const product = await productExists(productId);
  const policy = await reviewPolicy();
  const [item, existing] = await prisma.$transaction(async (tx) => Promise.all([
    purchase(tx, productId, accountId, policy), tx.review.findUnique({ where: { productId_accountId: { productId, accountId } }, include }),
  ]));
  return { product, policy, eligible: policy.enabled && (!policy.verifiedOnly || item !== null),
    existing: existing && !existing.deletedAt ? ownDto(existing, policy) : null, previouslyDeleted: Boolean(existing?.deletedAt) };
}
export async function myReviews(accountId: string, page: PageParams) {
  const policy = await reviewPolicy();
  const where = { accountId, deletedAt: null };
  const [total, rows] = await prisma.$transaction([prisma.review.count({ where }), prisma.review.findMany({ where, include, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], ...pageArgs(page) })]);
  return { policy, ...pageResult(rows.map((row) => ownDto(row, policy)), total, page) };
}
export async function submitReview(productId: string, accountId: string, input: ReviewInput) {
  await productExists(productId);
  const policy = await reviewPolicy(); assertEnabled(policy); assertLength(input, policy);
  try {
    return await prisma.$transaction(async (tx) => {
      const item = await purchase(tx, productId, accountId, policy);
      if (policy.verifiedOnly && !item) throw new AppError(403, 'REVIEW_NOT_ELIGIBLE', 'A delivered purchase of this product is required by the current review policy.');
      const account = await tx.account.findUniqueOrThrow({ where: { id: accountId }, select: { fullName: true } });
      const row = await tx.review.create({ data: { ...input, productId, accountId, purchaseItemId: item?.id ?? null,
        reviewerName: account.fullName || 'DoorKart customer', status: policy.requireApproval ? 'PENDING' : 'PUBLISHED' }, include });
      return ownDto(row, policy);
    });
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'P2002') throw conflict('REVIEW_EXISTS', 'You have already submitted a review for this product.');
    throw error;
  }
}
async function ownedReview(id: string, accountId: string) {
  const row = await prisma.review.findFirst({ where: { id, accountId, origin: 'CUSTOMER', deletedAt: null }, include });
  if (!row) throw notFound('REVIEW_NOT_FOUND', 'This review could not be found.');
  return row;
}
export async function editReview(id: string, accountId: string, input: ReviewInput) {
  const policy = await reviewPolicy(); assertEnabled(policy); assertLength(input, policy);
  const row = await ownedReview(id, accountId);
  await productExists(row.productId);
  if (!policy.allowEditing || !withinEditWindow(row, policy)) throw new AppError(403, 'REVIEW_POLICY', 'Editing is unavailable under the current review policy.');
  return prisma.$transaction(async (tx) => {
    const item = await purchase(tx, row.productId, accountId, policy);
    if (policy.verifiedOnly && !item) throw new AppError(403, 'REVIEW_NOT_ELIGIBLE', 'An eligible delivered purchase is required to edit this review.');
    // An edit cannot undo a moderator's hide. Other edits return to approval when required.
    const status = row.status === 'HIDDEN' ? 'HIDDEN' : policy.requireApproval || row.status === 'REJECTED' ? 'PENDING' : row.status;
    const updated = await tx.review.updateMany({ where: { id, accountId, deletedAt: null, status: row.status, updatedAt: row.updatedAt }, data: { ...input, status, purchaseItemId: item?.id ?? row.purchaseItemId } });
    if (updated.count !== 1) throw conflict('REVIEW_POLICY', 'This review changed. Refresh before editing it.');
    return ownDto(await tx.review.findUniqueOrThrow({ where: { id }, include }), policy);
  });
}
export async function deleteReview(id: string, accountId: string) {
  const policy = await reviewPolicy();
  const row = await ownedReview(id, accountId);
  if (!withinEditWindow(row, policy)) throw new AppError(403, 'REVIEW_POLICY', 'The review deletion window has ended. Contact the shop for help.');
  const result = await prisma.review.updateMany({ where: { id, accountId, deletedAt: null }, data: { deletedAt: new Date() } });
  if (!result.count) throw notFound('REVIEW_NOT_FOUND', 'This review could not be found.');
  return { deleted: true };
}

export async function adminReviews(query: AdminQuery) {
  const policy = await reviewPolicy();
  const where: Prisma.ReviewWhereInput = { ...(query.productId ? { productId: query.productId } : {}), ...(query.status ? { status: query.status } : {}),
    ...(query.origin ? { origin: query.origin } : {}), ...(query.deleted === undefined ? {} : { deletedAt: query.deleted ? { not: null } : null }),
    ...(query.verified === undefined ? {} : query.verified ? deliveredFilter(policy) : { NOT: deliveredFilter(policy) }),
    ...(query.search ? { OR: [{ title: { contains: query.search, mode: 'insensitive' } }, { content: { contains: query.search, mode: 'insensitive' } }, { reviewerName: { contains: query.search, mode: 'insensitive' } }, { product: { name: { contains: query.search, mode: 'insensitive' } } }] } : {}) };
  const [total, rows] = await prisma.$transaction([prisma.review.count({ where }), prisma.review.findMany({ where, include, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], ...pageArgs(query) })]);
  return pageResult(rows.map((row) => ({ ...dto(row, policy), deletedAt: row.deletedAt, moderationNote: row.moderationNote, moderatedAt: row.moderatedAt })), total, query);
}
export async function manualReview(adminId: string, input: ReviewInput & { productId: string; origin: 'ADMIN_ENTERED' | 'IMPORTED'; sourceLabel: string }) {
  await productExists(input.productId, false);
  const policy = await reviewPolicy(); assertEnabled(policy); assertLength(input, policy);
  const row = await prisma.review.create({ data: { ...input, createdByAdminId: adminId,
    reviewerName: input.origin === 'IMPORTED' ? 'Imported review' : 'Shop-entered review', status: 'PENDING' }, include });
  return dto(row, policy);
}
export async function moderateReview(id: string, adminId: string, action: 'approve' | 'reject' | 'hide' | 'restore', note?: string) {
  const policy = await reviewPolicy();
  const row = await prisma.review.findUnique({ where: { id }, include });
  if (!row || row.deletedAt) throw notFound('REVIEW_NOT_FOUND', 'This review is unavailable or was deleted by its author.');
  if ((action === 'hide' && row.status !== 'PUBLISHED') || (action === 'restore' && row.status !== 'HIDDEN') || (action === 'approve' && row.status === 'HIDDEN')) throw forbidden('Use the appropriate moderation action for this review status.');
  const status = action === 'approve' || action === 'restore' ? 'PUBLISHED' : action === 'hide' ? 'HIDDEN' : 'REJECTED';
  return prisma.$transaction(async (tx) => {
    const moderatedAt = new Date();
    const changed = await tx.review.updateMany({ where: { id, status: row.status, deletedAt: null, updatedAt: row.updatedAt }, data: { status, moderatedByAdminId: adminId, moderatedAt, moderationNote: note || null } });
    if (changed.count !== 1) throw conflict('REVIEW_POLICY', 'This review changed. Refresh and try again.');
    // Only a customer's own review notifies its author; shop-entered or imported ones have no recipient.
    if ((action === 'approve' || action === 'reject') && row.origin === 'CUSTOMER') {
      await emitReviewDecision(tx, { id, accountId: row.accountId, productId: row.productId, productName: row.product.name, reviewerName: row.reviewerName }, action, moderatedAt);
    }
    return dto(await tx.review.findUniqueOrThrow({ where: { id }, include }), policy);
  });
}
