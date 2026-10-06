import { describe, expect, it } from 'vitest';

import { createRequestFingerprint } from '../src/modules/orders/fingerprint.js';
import { createOrderBodySchema } from '../src/modules/orders/orders.schemas.js';

const baseRequest = {
  clientRequestId: 'request-id-0001',
  customer: { fullName: 'Ravi Kumar', mobile: '9876543210' },
  address: {
    addressLine1: '12 Shastri Street',
    addressLine2: 'Second floor',
    landmark: 'Near the temple',
    city: 'Lucknow',
    pincode: '226001',
  },
  deliveryAreaId: 'area-1',
  items: [
    { productId: 'product-a', quantity: 1 },
    { productId: 'product-b', quantity: 2 },
  ],
  paymentMethod: 'COD',
};

/** Fingerprints are computed from validated input, exactly as the API does. */
const fingerprintOf = (overrides: Record<string, unknown> = {}) =>
  createRequestFingerprint(createOrderBodySchema.parse({ ...baseRequest, ...overrides }));

describe('request fingerprint', () => {
  it('is a SHA-256 hex digest', () => {
    expect(fingerprintOf()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is the same for the same purchase and ignores the order of the items', () => {
    const reordered = fingerprintOf({ items: [...baseRequest.items].reverse() });
    expect(reordered).toBe(fingerprintOf());
  });

  it('ignores formatting that validation already normalises', () => {
    const formatted = fingerprintOf({
      customer: { fullName: '  Ravi Kumar ', mobile: '+91 98765 43210' },
      address: { ...baseRequest.address, landmark: '', addressLine2: 'Second floor ' },
    });
    const withoutLandmark = fingerprintOf({
      address: { ...baseRequest.address, landmark: undefined },
    });

    expect(formatted).toBe(
      fingerprintOf({ address: { ...baseRequest.address, landmark: null } })
    );
    // A blank and a missing optional field are the same intent.
    expect(
      fingerprintOf({ address: { ...baseRequest.address, landmark: '' } })
    ).toBe(withoutLandmark);
  });

  it('does not depend on the request id, which is what it is checked against', () => {
    expect(fingerprintOf({ clientRequestId: 'a-completely-different-id' })).toBe(fingerprintOf());
  });

  it('changes when anything about the purchase changes', () => {
    const original = fingerprintOf();
    const variants = [
      { customer: { ...baseRequest.customer, fullName: 'Someone Else' } },
      { customer: { ...baseRequest.customer, mobile: '9123456780' } },
      { address: { ...baseRequest.address, addressLine1: '13 Shastri Street' } },
      { address: { ...baseRequest.address, pincode: '226002' } },
      { deliveryAreaId: 'area-2' },
      { items: [{ productId: 'product-a', quantity: 2 }, baseRequest.items[1]] },
      { items: [baseRequest.items[0]] },
      { items: [...baseRequest.items, { productId: 'product-c', quantity: 1 }] },
    ];

    const fingerprints = variants.map((variant) => fingerprintOf(variant));
    expect(fingerprints.every((fingerprint) => fingerprint !== original)).toBe(true);
    expect(new Set(fingerprints).size).toBe(variants.length);
  });

  it('cannot be confused by values that run into each other', () => {
    const a = fingerprintOf({ address: { ...baseRequest.address, addressLine1: 'A', city: 'BC' } });
    const b = fingerprintOf({ address: { ...baseRequest.address, addressLine1: 'AB', city: 'C' } });
    expect(a).not.toBe(b);
  });
});
