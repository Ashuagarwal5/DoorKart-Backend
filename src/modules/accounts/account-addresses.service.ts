import type { AccountAddress } from '../../generated/prisma/client.js';
import { conflict, notFound, unauthenticated, unprocessable } from '../../lib/errors.js';
import { prisma, type TransactionClient } from '../../lib/prisma.js';
import { type AccountAddressInput, MAX_ACCOUNT_ADDRESSES } from './account-addresses.schemas.js';

// Stable creation order lets clients consistently promote the oldest remaining entry.
const addressOrder = [{ createdAt: 'asc' }, { id: 'asc' }] as const;

function toSavedAddress(address: AccountAddress) {
  return {
    id: address.id,
    label: address.label as AccountAddressInput['label'],
    isDefault: address.isDefault,
    fullName: address.fullName,
    phone: address.phone,
    addressLine1: address.addressLine1,
    addressLine2: address.addressLine2 ?? '',
    landmark: address.landmark ?? '',
    city: address.city,
    pincode: address.pincode,
    deliveryAreaId: address.deliveryAreaId,
  };
}

/** Serializes each account's limit/default changes without locking another customer's book. */
async function lockAccount(tx: TransactionClient, accountId: string) {
  const accounts = await tx.$queryRaw<{ id: string; isActive: boolean }[]>`
    SELECT "id", "isActive" FROM "Account" WHERE "id" = ${accountId} FOR UPDATE
  `;
  if (!accounts[0]?.isActive) throw unauthenticated();
}

async function validateArea(tx: TransactionClient, input: AccountAddressInput) {
  // An address can be saved before choosing a delivery area, including during signup.
  // Orders still require a selected active area and recheck its current pincode rules.
  if (input.deliveryAreaId === null) return;
  const area = await tx.deliveryArea.findUnique({ where: { id: input.deliveryAreaId } });
  if (!area) throw notFound('DELIVERY_AREA_NOT_FOUND', 'This delivery area does not exist.');
  if (!area.isActive) throw conflict('DELIVERY_AREA_UNAVAILABLE', `We no longer deliver to ${area.name}.`);
  if (area.pincode === null || area.pincode !== input.pincode) {
    throw unprocessable('DELIVERY_PINCODE_UNSUPPORTED',
      'Delivery is unavailable for this pincode in the selected area. Check your address or choose another delivery area.');
  }
}

async function ownedAddress(tx: TransactionClient, accountId: string, id: string) {
  const address = await tx.accountAddress.findFirst({ where: { id, accountId } });
  if (!address) throw notFound('ADDRESS_NOT_FOUND', 'This saved address was not found.');
  return address;
}

export async function listAccountAddresses(accountId: string) {
  const addresses = await prisma.accountAddress.findMany({ where: { accountId }, orderBy: [...addressOrder] });
  return addresses.map(toSavedAddress);
}

/** Creates a saved address using the caller's transaction and the same ownership/default guards. */
export async function createAccountAddressInTransaction(
  tx: TransactionClient, accountId: string, input: AccountAddressInput,
) {
  await lockAccount(tx, accountId);
  const count = await tx.accountAddress.count({ where: { accountId } });
  if (count >= MAX_ACCOUNT_ADDRESSES) {
    throw conflict('ADDRESS_BOOK_FULL', `You can save up to ${MAX_ACCOUNT_ADDRESSES} addresses. Delete one to add another.`);
  }
  await validateArea(tx, input);
  const isDefault = input.isDefault || count === 0;
  if (isDefault) await tx.accountAddress.updateMany({ where: { accountId, isDefault: true }, data: { isDefault: false } });
  return toSavedAddress(await tx.accountAddress.create({ data: { ...input, accountId, isDefault } }));
}

export const createAccountAddress = (accountId: string, input: AccountAddressInput) =>
  prisma.$transaction((tx) => createAccountAddressInTransaction(tx, accountId, input));

export async function updateAccountAddress(accountId: string, id: string, input: AccountAddressInput) {
  return prisma.$transaction(async (tx) => {
    await lockAccount(tx, accountId);
    const existing = await ownedAddress(tx, accountId, id);
    await validateArea(tx, input);
    // Changing the default requires selecting another address, so a nonempty book always has one.
    const isDefault = input.isDefault || existing.isDefault;
    if (isDefault) await tx.accountAddress.updateMany({ where: { accountId, isDefault: true }, data: { isDefault: false } });
    return toSavedAddress(await tx.accountAddress.update({ where: { id: existing.id }, data: { ...input, isDefault } }));
  });
}

export async function deleteAccountAddress(accountId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    await lockAccount(tx, accountId);
    const existing = await ownedAddress(tx, accountId, id);
    await tx.accountAddress.delete({ where: { id: existing.id } });
    if (existing.isDefault) {
      const remaining = await tx.accountAddress.findFirst({ where: { accountId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      if (remaining) await tx.accountAddress.update({ where: { id: remaining.id }, data: { isDefault: true } });
    }
    return { deleted: true };
  });
}

export async function setDefaultAccountAddress(accountId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    await lockAccount(tx, accountId);
    const existing = await ownedAddress(tx, accountId, id);
    await tx.accountAddress.updateMany({ where: { accountId, isDefault: true }, data: { isDefault: false } });
    await tx.accountAddress.update({ where: { id: existing.id }, data: { isDefault: true } });
    const addresses = await tx.accountAddress.findMany({ where: { accountId }, orderBy: [...addressOrder] });
    return addresses.map(toSavedAddress);
  });
}
