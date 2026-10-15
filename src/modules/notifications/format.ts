/** Customer-facing formatting. Money is INR from integer paise; dates are IST calendar dates. */

export function formatInr(paise: number): string {
  const whole = Math.floor(paise / 100).toLocaleString('en-IN');
  const cents = String(paise % 100).padStart(2, '0');
  return `₹${whole}.${cents}`;
}

const istDate = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

export function formatIstDate(iso: string): string | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : istDate.format(date);
}

const ORDER_STATUS_LABELS: Record<string, string> = {
  PLACED: 'Placed',
  CONFIRMED: 'Confirmed',
  PACKED: 'Packed',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  DELIVERY_FAILED: 'Delivery failed',
};
const PAYMENT_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Pending',
  COLLECTED: 'Collected',
  REFUNDED: 'Refunded',
};
const PAYMENT_METHOD_LABELS: Record<string, string> = { COD: 'Cash on Delivery' };
const RETURN_STATUS_LABELS: Record<string, string> = {
  REQUESTED: 'Requested',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  COMPLETED: 'Completed',
};

export const orderStatusLabel = (value: string) => ORDER_STATUS_LABELS[value] ?? null;
export const paymentStatusLabel = (value: string) => PAYMENT_STATUS_LABELS[value] ?? null;
export const paymentMethodLabel = (value: string) => PAYMENT_METHOD_LABELS[value] ?? null;
export const returnStatusLabel = (value: string) => RETURN_STATUS_LABELS[value] ?? null;

/** Removes control characters and collapses whitespace so a value cannot break layout. */
export function cleanText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function truncate(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}
