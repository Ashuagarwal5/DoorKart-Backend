import { describe, expect, it } from 'vitest';

import { normalizeIndianMobile } from '../src/lib/mobile.js';
import {
  calculateDeliveryCharge,
  calculateLineTotal,
  calculateOrderTotals,
  calculateSubtotal,
} from '../src/lib/pricing.js';

describe('pricing (integer paise)', () => {
  it('multiplies paise exactly where rupee floats would drift', () => {
    // 149.50 * 3 in floating point rupees is 448.49999999999994
    expect(calculateLineTotal(14950, 3)).toBe(44850);
    expect(calculateSubtotal([{ unitPricePaise: 1010, quantity: 3 }])).toBe(3030);
  });

  it('adds lines, delivery and discount into whole paise', () => {
    const totals = calculateOrderTotals(
      [
        { unitPricePaise: 14950, quantity: 1 },
        { unitPricePaise: 34900, quantity: 2 },
      ],
      { deliveryChargePaise: 3000, freeDeliveryThresholdPaise: 100000 }
    );

    expect(totals).toEqual({
      subtotalPaise: 84750,
      deliveryChargePaise: 3000,
      discountPaise: 0,
      grandTotalPaise: 87750,
    });
    expect(Object.values(totals).every(Number.isInteger)).toBe(true);
  });

  it('makes delivery free exactly at the threshold, not one paisa below', () => {
    const rule = { deliveryChargePaise: 3000, freeDeliveryThresholdPaise: 50000 };
    expect(calculateDeliveryCharge(49999, rule)).toBe(3000);
    expect(calculateDeliveryCharge(50000, rule)).toBe(0);
  });

  it('always charges when the area has no free-delivery threshold', () => {
    const rule = { deliveryChargePaise: 2000, freeDeliveryThresholdPaise: null };
    expect(calculateDeliveryCharge(10_000_000, rule)).toBe(2000);
  });

  it('refuses fractional paise instead of silently rounding', () => {
    expect(() => calculateLineTotal(149.5, 1)).toThrow();
  });
});

describe('normalizeIndianMobile', () => {
  it('reduces every accepted format to the same 10 digits', () => {
    for (const input of ['9876543210', '+91 98765 43210', '919876543210', '098765-43210']) {
      expect(normalizeIndianMobile(input)).toBe('9876543210');
    }
  });

  it('rejects numbers that are not Indian mobiles', () => {
    for (const input of ['12345', '5876543210', '98765432101', 'abcdefghij', '']) {
      expect(normalizeIndianMobile(input)).toBeNull();
    }
  });
});
