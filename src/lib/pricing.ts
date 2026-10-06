/**
 * The one place order amounts are calculated. Everything is integer paise, so there is
 * no floating point money arithmetic anywhere. Inputs always come from the database,
 * never from the client.
 */

type PricedLine = {
  unitPricePaise: number;
  quantity: number;
};

type DeliveryRule = {
  deliveryChargePaise: number;
  freeDeliveryThresholdPaise: number | null;
};

export type OrderTotals = {
  subtotalPaise: number;
  deliveryChargePaise: number;
  discountPaise: number;
  grandTotalPaise: number;
};

function assertPaise(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer number of paise, got ${value}`);
  }
  return value;
}

export function calculateLineTotal(unitPricePaise: number, quantity: number): number {
  return assertPaise(unitPricePaise * quantity, 'Line total');
}

export function calculateSubtotal(lines: PricedLine[]): number {
  return assertPaise(
    lines.reduce((sum, line) => sum + calculateLineTotal(line.unitPricePaise, line.quantity), 0),
    'Subtotal'
  );
}

export function calculateDeliveryCharge(subtotalPaise: number, rule: DeliveryRule): number {
  const isFree =
    rule.freeDeliveryThresholdPaise !== null && subtotalPaise >= rule.freeDeliveryThresholdPaise;
  return isFree ? 0 : assertPaise(rule.deliveryChargePaise, 'Delivery charge');
}

export function calculateOrderTotals(lines: PricedLine[], rule: DeliveryRule): OrderTotals {
  const subtotalPaise = calculateSubtotal(lines);
  const deliveryChargePaise = calculateDeliveryCharge(subtotalPaise, rule);
  // Coupons do not exist yet; the column exists so orders keep a stable shape when they do.
  const discountPaise = 0;

  return {
    subtotalPaise,
    deliveryChargePaise,
    discountPaise,
    grandTotalPaise: assertPaise(subtotalPaise + deliveryChargePaise - discountPaise, 'Grand total'),
  };
}
