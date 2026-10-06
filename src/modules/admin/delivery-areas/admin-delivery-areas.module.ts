import { Router } from 'express';
import { z } from 'zod';

import type { DeliveryArea } from '../../../generated/prisma/client.js';
import { conflict, notFound } from '../../../lib/errors.js';
import { sendSuccess } from '../../../lib/http.js';
import { idParamsSchema } from '../../../lib/params.js';
import { isUniqueViolation } from '../../../lib/prisma-errors.js';
import { prisma } from '../../../lib/prisma.js';

/** ₹10,00,000 in paise: a sanity ceiling that catches a stray extra zero, not a business limit. */
const MAX_PAISE = 100_000_000;

/** Integer paise, never a float and never negative. */
const paise = z.number().int().min(0).max(MAX_PAISE);

const areaFields = {
  name: z.string().trim().min(1).max(100),
  pincode: z
    .string()
    .trim()
    .regex(/^[1-9]\d{5}$/, 'Pincode must be 6 digits')
    .nullish()
    .transform((value) => value ?? null),
  deliveryChargePaise: paise,
  // null means "no minimum" / "no free delivery".
  minimumOrderPaise: paise.nullish().transform((value) => value ?? null),
  freeDeliveryThresholdPaise: paise.nullish().transform((value) => value ?? null),
  isActive: z.boolean(),
};

const createBodySchema = z.strictObject({
  name: areaFields.name,
  pincode: areaFields.pincode,
  deliveryChargePaise: areaFields.deliveryChargePaise,
  minimumOrderPaise: areaFields.minimumOrderPaise,
  freeDeliveryThresholdPaise: areaFields.freeDeliveryThresholdPaise,
  isActive: areaFields.isActive.default(true),
});

const updateBodySchema = z
  .strictObject(areaFields)
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'Send at least one field to change' });

function toAdminArea(area: DeliveryArea) {
  return {
    id: area.id,
    name: area.name,
    pincode: area.pincode,
    deliveryChargePaise: area.deliveryChargePaise,
    minimumOrderPaise: area.minimumOrderPaise,
    freeDeliveryThresholdPaise: area.freeDeliveryThresholdPaise,
    isActive: area.isActive,
    createdAt: area.createdAt,
    updatedAt: area.updatedAt,
  };
}

async function assertNameFree(name: string, exceptId?: string) {
  const taken = await prisma.deliveryArea.findFirst({
    where: { name, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (taken) {
    throw conflict('DUPLICATE_NAME', `There is already a delivery area called "${name}".`);
  }
}

function translateUniqueViolation(error: unknown): never {
  if (isUniqueViolation(error, 'name')) {
    throw conflict('DUPLICATE_NAME', 'There is already a delivery area with that name.');
  }
  throw error;
}

export const adminDeliveryAreasRouter = Router();

/** All areas, inactive ones included. */
adminDeliveryAreasRouter.get('/', async (_req, res) => {
  const areas = await prisma.deliveryArea.findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }] });
  sendSuccess(res, areas.map(toAdminArea));
});

adminDeliveryAreasRouter.post('/', async (req, res) => {
  const body = createBodySchema.parse(req.body);
  await assertNameFree(body.name);
  try {
    sendSuccess(res, toAdminArea(await prisma.deliveryArea.create({ data: body })), 201);
  } catch (error) {
    translateUniqueViolation(error);
  }
});

/**
 * Areas are never deleted (past orders refer to them): set `isActive` to false and the
 * shop stops accepting new orders for it. Changed charges apply to new orders only; an
 * order already placed keeps the charge it was given.
 */
adminDeliveryAreasRouter.patch('/:id', async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);
  const body = updateBodySchema.parse(req.body);

  const existing = await prisma.deliveryArea.findUnique({ where: { id }, select: { name: true } });
  if (!existing) {
    throw notFound('DELIVERY_AREA_NOT_FOUND', 'This delivery area does not exist.');
  }
  if (body.name !== undefined && body.name !== existing.name) {
    await assertNameFree(body.name, id);
  }

  try {
    sendSuccess(res, toAdminArea(await prisma.deliveryArea.update({ where: { id }, data: body })));
  } catch (error) {
    translateUniqueViolation(error);
  }
});
