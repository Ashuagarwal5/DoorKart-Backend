import { createHash } from 'node:crypto';

import type { CreateOrderInput } from './orders.schemas.js';

/** Bump when the canonical form changes; old fingerprints then stop matching on purpose. */
const FINGERPRINT_VERSION = 'v1';

function byProductId(a: [string, number], b: [string, number]): number {
  // Plain code-unit comparison: the same order on every machine and locale.
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

/**
 * A SHA-256 of what the customer asked to buy: who, where, from which area, which
 * products and how many, and how they pay. Two requests with the same fingerprint are
 * the same purchase intent.
 *
 * It runs on the validated input, so formatting differences that validation already
 * erases (a "+91 98765 43210" and a "9876543210", a blank and a missing address line 2)
 * produce the same value, and the order of the items is irrelevant. It leaves out
 * everything the server decides (prices, totals, order number, token, timestamps) and the
 * clientRequestId itself, which is what the fingerprint is checked against.
 */
export function createRequestFingerprint(input: CreateOrderInput): string {
  const { customer, address } = input;

  // Arrays in a fixed order, not objects: no key-order ambiguity, and JSON escaping keeps
  // the fields from running into each other.
  const canonical = JSON.stringify([
    FINGERPRINT_VERSION,
    [customer.fullName, customer.mobile],
    [address.addressLine1, address.addressLine2, address.landmark, address.city, address.pincode],
    input.deliveryAreaId,
    input.items.map((item): [string, number] => [item.productId, item.quantity]).sort(byProductId),
    input.paymentMethod,
  ]);

  return createHash('sha256').update(canonical).digest('hex');
}
