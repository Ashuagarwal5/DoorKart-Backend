import type { Prisma } from '../../../generated/prisma/client.js';
import { AppError, conflict, notFound } from '../../../lib/errors.js';
import { pageArgs, pageResult } from '../../../lib/pagination.js';
import { isUniqueViolation } from '../../../lib/prisma-errors.js';
import { prisma } from '../../../lib/prisma.js';
import { slugify } from '../../../lib/slug.js';
import { uploadedFileExists } from '../../media/media-storage.js';
import { UPLOAD_URL_PREFIX } from '../../media/media-types.js';
import type { AdminContext } from '../auth/session.js';
import type {
  CreateProductBody,
  InventoryAdjustmentBody,
  ListProductsQuery,
  UpdateProductBody,
} from './admin-products.schemas.js';

const productInclude = {
  category: { select: { id: true, name: true, slug: true } },
  images: { orderBy: { displayOrder: 'asc' } },
} satisfies Prisma.ProductInclude;

type ProductWithRelations = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

/**
 * `availableQuantity` is worked out here, never stored: stock on hand minus units held by
 * orders that have not been delivered or cancelled yet.
 */
function toAdminProduct(product: ProductWithRelations) {
  const availableQuantity = product.stockQuantity - product.reservedQuantity;
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    description: product.description,
    categoryId: product.categoryId,
    category: product.category,
    sku: product.sku,
    mrpPaise: product.mrpPaise,
    sellingPricePaise: product.sellingPricePaise,
    stockQuantity: product.stockQuantity,
    reservedQuantity: product.reservedQuantity,
    availableQuantity,
    lowStockThreshold: product.lowStockThreshold,
    isLowStock: availableQuantity <= product.lowStockThreshold,
    isActive: product.isActive,
    isFeatured: product.isFeatured,
    isNew: product.isNew,
    images: product.images.map((image) => ({
      id: image.id,
      url: image.url,
      mediaType: image.mediaType,
      altText: image.altText,
      displayOrder: image.displayOrder,
    })),
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

export type AdminProduct = ReturnType<typeof toAdminProduct>;

async function loadProduct(id: string): Promise<ProductWithRelations> {
  const product = await prisma.product.findUnique({ where: { id }, include: productInclude });
  if (!product) {
    throw notFound('PRODUCT_NOT_FOUND', 'This product does not exist.');
  }
  return product;
}

/** Friendly duplicate checks. The database's unique indexes still back them up. */
async function assertUnique(values: { sku?: string; slug?: string }, exceptProductId?: string) {
  const notSelf = exceptProductId ? { id: { not: exceptProductId } } : {};

  if (values.sku !== undefined) {
    const taken = await prisma.product.findFirst({
      where: { sku: values.sku, ...notSelf },
      select: { id: true },
    });
    if (taken) {
      throw conflict('DUPLICATE_SKU', `The SKU "${values.sku}" is already used by another product.`);
    }
  }
  if (values.slug !== undefined) {
    const taken = await prisma.product.findFirst({
      where: { slug: values.slug, ...notSelf },
      select: { id: true },
    });
    if (taken) {
      throw conflict('DUPLICATE_SLUG', `The slug "${values.slug}" is already used by another product.`);
    }
  }
}

/** Turns the database's own duplicate refusal (a lost race) into the same friendly error. */
function translateUniqueViolation(error: unknown): never {
  if (isUniqueViolation(error, 'sku')) {
    throw conflict('DUPLICATE_SKU', 'That SKU is already used by another product.');
  }
  if (isUniqueViolation(error, 'slug')) {
    throw conflict('DUPLICATE_SLUG', 'That slug is already used by another product.');
  }
  throw error;
}

async function assertCategoryExists(categoryId: string) {
  const category = await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } });
  if (!category) {
    throw notFound('CATEGORY_NOT_FOUND', 'This category does not exist.');
  }
}

/** A product may only point at uploaded files that really exist, so a typo or a cleaned-up file cannot leave a broken picture. */
async function assertUploadedFilesExist(images: CreateProductBody['images']) {
  for (const [index, image] of images.entries()) {
    if (image.url.startsWith(UPLOAD_URL_PREFIX) && !(await uploadedFileExists(image.url))) {
      throw new AppError(400, 'VALIDATION_ERROR', 'One of the uploaded files could not be found. Upload it again.', [
        { field: `images.${index}.url`, message: 'This uploaded file no longer exists' },
      ]);
    }
  }
}

function imageRows(images: CreateProductBody['images']) {
  return images.map((image, displayOrder) => ({
    url: image.url,
    mediaType: image.mediaType,
    altText: image.altText,
    displayOrder,
  }));
}

export async function listProducts(query: ListProductsQuery) {
  const where: Prisma.ProductWhereInput = {
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' } },
            { sku: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  // "Low stock" compares two columns (stock - reserved against the threshold), which the
  // query builder cannot express, so the matching ids come from SQL.
  if (query.lowStock !== undefined) {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Product"
      WHERE ("stockQuantity" - "reservedQuantity") <= "lowStockThreshold"
    `;
    const ids = rows.map((row) => row.id);
    where.id = query.lowStock ? { in: ids } : { notIn: ids };
  }

  const [total, products] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      include: productInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      ...pageArgs(query),
    }),
  ]);
  return pageResult(products.map(toAdminProduct), total, query);
}

export async function getProduct(id: string): Promise<AdminProduct> {
  return toAdminProduct(await loadProduct(id));
}

export async function createProduct(body: CreateProductBody, admin: AdminContext) {
  const slug = body.slug ?? slugify(body.name);
  if (slug === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Give the product a slug: the name has no letters or digits to build one from.');
  }

  await assertCategoryExists(body.categoryId);
  await assertUnique({ sku: body.sku, slug });
  await assertUploadedFilesExist(body.images);

  try {
    const created = await prisma.product.create({
      data: {
        name: body.name,
        slug,
        description: body.description,
        categoryId: body.categoryId,
        sku: body.sku,
        mrpPaise: body.mrpPaise,
        sellingPricePaise: body.sellingPricePaise,
        stockQuantity: body.stockQuantity,
        lowStockThreshold: body.lowStockThreshold,
        isFeatured: body.isFeatured,
        isNew: body.isNew,
        isActive: body.isActive,
        images: { create: imageRows(body.images) },
        // Opening stock is a stock movement like any other, so the audit trail starts complete.
        ...(body.stockQuantity > 0
          ? {
              inventoryTransactions: {
                create: {
                  type: 'ADJUSTMENT',
                  quantity: body.stockQuantity,
                  note: 'Opening stock',
                  adminUserId: admin.id,
                },
              },
            }
          : {}),
      },
      include: productInclude,
    });
    return toAdminProduct(created);
  } catch (error) {
    return translateUniqueViolation(error);
  }
}

/**
 * Edits a product's details. Products are never deleted (orders refer to them): to take
 * one off sale, set `isActive` to false. Stock is not editable here, only by adjustment.
 */
export async function updateProduct(id: string, body: UpdateProductBody) {
  const existing = await loadProduct(id);

  // A price change is checked against the stored price for the field not being sent.
  const mrpPaise = body.mrpPaise ?? existing.mrpPaise;
  const sellingPricePaise = body.sellingPricePaise ?? existing.sellingPricePaise;
  if (sellingPricePaise > mrpPaise) {
    throw new AppError(400, 'VALIDATION_ERROR', 'The selling price cannot be higher than the MRP.', [
      { field: 'sellingPricePaise', message: 'The selling price cannot be higher than the MRP' },
    ]);
  }

  if (body.categoryId !== undefined && body.categoryId !== existing.categoryId) {
    await assertCategoryExists(body.categoryId);
  }
  if (body.images !== undefined) {
    await assertUploadedFilesExist(body.images);
  }
  await assertUnique(
    {
      sku: body.sku !== existing.sku ? body.sku : undefined,
      slug: body.slug !== existing.slug ? body.slug : undefined,
    },
    id
  );

  const { images, ...fields } = body;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.product.update({ where: { id }, data: fields });
      if (images !== undefined) {
        await tx.productImage.deleteMany({ where: { productId: id } });
        await tx.productImage.createMany({
          data: imageRows(images).map((image) => ({ ...image, productId: id })),
        });
      }
    });
  } catch (error) {
    return translateUniqueViolation(error);
  }

  return getProduct(id);
}

/**
 * Changes stock on hand by a signed amount and records why. This is the ONLY way to change
 * stockQuantity by hand. The write refuses to take stock below what open orders have
 * reserved, so an adjustment can never leave an order without the units it was promised.
 * The check is part of the UPDATE, so it holds even when orders arrive at the same moment.
 */
export async function adjustInventory(
  id: string,
  body: InventoryAdjustmentBody,
  admin: AdminContext
): Promise<AdminProduct> {
  await prisma.$transaction(async (tx) => {
    const updatedRows = await tx.$executeRaw`
      UPDATE "Product"
      SET "stockQuantity" = "stockQuantity" + ${body.quantityDelta}::int, "updatedAt" = NOW()
      WHERE "id" = ${id}
        AND "stockQuantity" + ${body.quantityDelta}::int >= "reservedQuantity"
    `;

    if (updatedRows !== 1) {
      const product = await tx.product.findUnique({
        where: { id },
        select: { stockQuantity: true, reservedQuantity: true },
      });
      if (!product) {
        throw notFound('PRODUCT_NOT_FOUND', 'This product does not exist.');
      }
      const available = product.stockQuantity - product.reservedQuantity;
      throw conflict(
        'ADJUSTMENT_BELOW_RESERVED',
        `Stock cannot go below the ${product.reservedQuantity} units already reserved by open orders.`,
        {
          stockQuantity: product.stockQuantity,
          reservedQuantity: product.reservedQuantity,
          requestedDelta: body.quantityDelta,
          lowestAllowedDelta: -available,
        }
      );
    }

    await tx.inventoryTransaction.create({
      data: {
        productId: id,
        type: 'ADJUSTMENT',
        quantity: body.quantityDelta,
        note: body.note,
        adminUserId: admin.id,
      },
    });
  });

  return getProduct(id);
}
