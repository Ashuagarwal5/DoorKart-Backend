import { z } from 'zod';

import { Prisma } from '../../generated/prisma/client.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { normalizeEmail } from '../../lib/email.js';
import { pageArgs, pageResult, paginationQuery, searchText } from '../../lib/pagination.js';
import { prisma, type TransactionClient } from '../../lib/prisma.js';
import { readSettings, shopInfo } from '../settings/settings.service.js';
import { EVENT_DEFINITIONS, getEvent } from './events.js';
import { BODY_MAX, renderNotification, TITLE_MAX, validateTemplateText } from './render.js';
import { isTargetScreen, resolveTarget, TARGET_SCREEN_KEYS, type TargetScreen } from './targets.js';
import { SAMPLE_CONTEXT, SAMPLE_STORE } from './variables.js';

const eventKey = z.string().refine((value) => getEvent(value) !== undefined, 'Unknown event.');
const targetScreen = z.string().refine((value) => isTargetScreen(value), 'Unknown destination.');

const metadata = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,29}$/), z.string().trim().max(200))
  .refine((value) => Object.keys(value).length <= 10, 'At most 10 metadata entries.');

const templateFields = {
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{2,59}$/, 'Use 3–60 lowercase letters, digits or underscores, starting with a letter.'),
  name: z.string().trim().min(3).max(100),
  eventKey,
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(600),
  imageUrl: z.string().trim().max(500).regex(/^https:\/\/\S+$/i, 'Use a full https:// address.').nullish().transform((v) => v ?? null),
  targetScreen: targetScreen.nullish().transform((v) => v ?? null),
  metadata: metadata.nullish().transform((v) => v ?? null),
  isEnabled: z.boolean().default(false),
};

export const createTemplateBody = z.strictObject(templateFields);
export const updateTemplateBody = z.strictObject(templateFields).omit({ key: true });
export const previewBody = z.strictObject({
  eventKey,
  title: z.string().max(200),
  body: z.string().max(600),
  targetScreen: targetScreen.nullish(),
});
export const listTemplatesQuery = z.strictObject({
  ...paginationQuery,
  search: searchText,
  eventKey: eventKey.optional(),
  enabled: z.enum(['true', 'false']).optional(),
});
export const testSendBody = z.strictObject({ accountEmail: z.email().max(200) });

export type TemplateInput = z.infer<typeof createTemplateBody>;

const templateSelect = {
  id: true, key: true, name: true, eventKey: true, title: true, body: true, imageUrl: true,
  targetScreen: true, metadata: true, isEnabled: true, createdByAdminId: true, updatedByAdminId: true,
  createdAt: true, updatedAt: true,
} satisfies Prisma.NotificationTemplateSelect;

function validateContent(input: { eventKey: string; title: string; body: string }): void {
  const details = [
    ...validateTemplateText(input.title, input.eventKey).map((message) => ({ field: 'title', message })),
    ...validateTemplateText(input.body, input.eventKey).map((message) => ({ field: 'body', message })),
  ];
  if (details.length > 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'The template uses variables that are not allowed.', details);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'P2002';
}

async function loadTemplate(id: string) {
  const row = await prisma.notificationTemplate.findUnique({ where: { id }, select: templateSelect });
  if (!row) throw notFound('NOTIFICATION_TEMPLATE_NOT_FOUND', 'This template does not exist.');
  return row;
}

/** Enabling a template turns off the other enabled template of the same event, atomically. */
async function saveWithExclusivity<T>(
  tx: TransactionClient,
  eventKeyValue: string,
  enabling: boolean,
  selfId: string | null,
  write: () => Promise<T>
): Promise<T> {
  if (enabling) {
    await tx.notificationTemplate.updateMany({
      where: { eventKey: eventKeyValue, isEnabled: true, ...(selfId ? { id: { not: selfId } } : {}) },
      data: { isEnabled: false },
    });
  }
  return write();
}

export async function createTemplate(input: TemplateInput, adminId: string) {
  validateContent(input);
  try {
    return await prisma.$transaction((tx) =>
      saveWithExclusivity(tx, input.eventKey, input.isEnabled, null, () =>
        tx.notificationTemplate.create({
          data: {
            key: input.key, name: input.name, eventKey: input.eventKey, title: input.title, body: input.body,
            imageUrl: input.imageUrl, targetScreen: input.targetScreen,
            metadata: input.metadata ?? undefined, isEnabled: input.isEnabled,
            createdByAdminId: adminId, updatedByAdminId: adminId,
          },
          select: templateSelect,
        })
      )
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict('DUPLICATE_TEMPLATE_KEY', `The identifier "${input.key}" is already used by another template.`);
    }
    throw error;
  }
}

export async function updateTemplate(id: string, input: z.infer<typeof updateTemplateBody>, adminId: string) {
  await loadTemplate(id);
  validateContent(input);
  try {
    return await prisma.$transaction((tx) =>
      saveWithExclusivity(tx, input.eventKey, input.isEnabled, id, () =>
        tx.notificationTemplate.update({
          where: { id },
          data: {
            name: input.name, eventKey: input.eventKey, title: input.title, body: input.body,
            imageUrl: input.imageUrl, targetScreen: input.targetScreen,
            metadata: input.metadata ?? Prisma.JsonNull, isEnabled: input.isEnabled, updatedByAdminId: adminId,
          },
          select: templateSelect,
        })
      )
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict('TEMPLATE_EVENT_CONFLICT', 'Another template for this event was enabled at the same time. Try again.');
    }
    throw error;
  }
}


export async function setTemplateEnabled(id: string, isEnabled: boolean, adminId: string) {
  const current = await loadTemplate(id);
  return prisma.$transaction((tx) =>
    saveWithExclusivity(tx, current.eventKey, isEnabled, id, () =>
      tx.notificationTemplate.update({
        where: { id },
        data: { isEnabled, updatedByAdminId: adminId },
        select: templateSelect,
      })
    )
  );
}

/** History keeps its own copy of the rendered text and the template name, so deletion is safe. */
export async function deleteTemplate(id: string): Promise<void> {
  await loadTemplate(id);
  await prisma.notificationTemplate.delete({ where: { id } });
}

export async function duplicateTemplate(id: string, adminId: string) {
  const source = await loadTemplate(id);
  for (let suffix = 1; suffix <= 20; suffix += 1) {
    const key = `${source.key}_copy${suffix === 1 ? '' : suffix}`.slice(0, 60);
    try {
      return await prisma.notificationTemplate.create({
        data: {
          key, name: `${source.name} (copy)`.slice(0, 100), eventKey: source.eventKey, title: source.title,
          body: source.body, imageUrl: source.imageUrl, targetScreen: source.targetScreen,
          metadata: source.metadata ?? undefined, isEnabled: false, createdByAdminId: adminId, updatedByAdminId: adminId,
        },
        select: templateSelect,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  throw conflict('DUPLICATE_TEMPLATE_KEY', 'Could not find a free identifier for the copy.');
}

export async function getTemplate(id: string) {
  return loadTemplate(id);
}

export async function listTemplates(query: z.infer<typeof listTemplatesQuery>) {
  const where: Prisma.NotificationTemplateWhereInput = {
    ...(query.eventKey ? { eventKey: query.eventKey } : {}),
    ...(query.enabled ? { isEnabled: query.enabled === 'true' } : {}),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' } },
            { key: { contains: query.search, mode: 'insensitive' } },
            { title: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
  const [total, rows] = await prisma.$transaction([
    prisma.notificationTemplate.count({ where }),
    prisma.notificationTemplate.findMany({
      where, select: templateSelect, orderBy: [{ eventKey: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }], ...pageArgs(query),
    }),
  ]);
  return pageResult(rows, total, query);
}

/** Renders unsaved text with sample data, exactly as the worker would for a customer. */
export function previewTemplate(input: z.infer<typeof previewBody>) {
  const problems = [
    ...validateTemplateText(input.title, input.eventKey).map((message) => ({ field: 'title', message })),
    ...validateTemplateText(input.body, input.eventKey).map((message) => ({ field: 'body', message })),
  ];
  const definition = getEvent(input.eventKey)!;
  const screen: TargetScreen = input.targetScreen && isTargetScreen(input.targetScreen) ? input.targetScreen : definition.defaultTarget;
  return {
    problems,
    rendered: renderNotification(input, SAMPLE_CONTEXT, SAMPLE_STORE),
    limits: { title: TITLE_MAX, body: BODY_MAX },
    target: resolveTarget(screen, SAMPLE_CONTEXT),
  };
}

/**
 * Queues a clearly marked sample notification for one account's devices (and inbox). Only
 * the worker sends it, through the same path as real events.
 */
export async function sendTestNotification(templateId: string, accountEmail: string) {
  const template = await loadTemplate(templateId);
  const account = await prisma.account.findUnique({
    where: { email: normalizeEmail(accountEmail) },
    select: { id: true, isActive: true },
  });
  if (!account?.isActive) throw notFound('NOTIFICATION_NOT_FOUND', 'No active customer account has this email.');

  const definition = getEvent(template.eventKey);
  const settings = await readSettings();
  const info = shopInfo(settings);
  const store = { name: info.name, supportEmail: info.email, supportPhone: info.phone };
  const rendered = renderNotification(template, SAMPLE_CONTEXT, store);
  const screen: TargetScreen = template.targetScreen && isTargetScreen(template.targetScreen)
    ? template.targetScreen
    : (definition?.defaultTarget ?? 'NOTIFICATIONS');
  // A sample order does not exist for the customer, so a test always opens the inbox.
  const target = resolveTarget(screen === 'NOTIFICATIONS' ? screen : 'NOTIFICATIONS', SAMPLE_CONTEXT);

  return prisma.notification.create({
    data: {
      accountId: account.id,
      eventKey: template.eventKey,
      templateId: template.id,
      templateKey: template.key,
      templateName: template.name,
      title: `[Test] ${rendered.title}`.slice(0, 120),
      body: rendered.body,
      pushTitle: `[Test] ${rendered.pushTitle}`.slice(0, 120),
      pushBody: rendered.pushBody,
      imageUrl: template.imageUrl,
      targetScreen: target.screen,
      targetParams: target.params,
      isTest: true,
    },
    select: { id: true, status: true },
  });
}

export const TARGET_SCREEN_OPTIONS = TARGET_SCREEN_KEYS;
export const EVENT_OPTIONS = EVENT_DEFINITIONS;
