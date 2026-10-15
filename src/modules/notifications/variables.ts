import type { NotificationContext } from './context.js';
import {
  formatInr,
  formatIstDate,
  orderStatusLabel,
  paymentMethodLabel,
  paymentStatusLabel,
  returnStatusLabel,
} from './format.js';

/**
 * Every placeholder an administrator may use. A variable is a pure function of the stored
 * event snapshot (plus shop details): no database access, no expressions, no code from
 * templates. Adding a variable means adding one entry here and naming its group in events.ts.
 */

export type VariableGroup = 'customer' | 'order' | 'product' | 'return' | 'store';

export type StoreInfo = { name: string; supportEmail: string | null; supportPhone: string | null };

export type VariableDefinition = {
  key: string;
  label: string;
  description: string;
  group: VariableGroup;
  type: 'text' | 'number' | 'currency' | 'date';
  /** Personal data that would show on a lock screen: the inbox gets the value, a push gets the fallback. */
  sensitive?: boolean;
  /** Used when the value is unavailable (and in a push for a sensitive variable). */
  fallback: string;
  sample: string;
  resolve: (context: NotificationContext, store: StoreInfo) => string | null;
};

const firstWord = (value: string | null | undefined) => value?.trim().split(/\s+/)[0] || null;
const only = <T,>(items: T[] | undefined): T | null => (items?.length === 1 ? (items[0] as T) : null);
const totalUnits = (context: NotificationContext) =>
  (context.items ?? []).reduce((sum, item) => sum + item.quantity, 0);

function productSummary(context: NotificationContext): string | null {
  const items = context.items ?? [];
  if (items.length === 0) return null;
  const first = items[0]!.name;
  return items.length === 1 ? first : `${first} and ${items.length - 1} more`;
}

function refundStatus(context: NotificationContext): string | null {
  const value = context.return;
  if (!value) return null;
  const amount = value.refundAmountPaise ?? 0;
  if (value.status === 'REJECTED') return 'Rejected';
  if (amount === 0) return 'No refund due';
  if (value.status === 'COMPLETED') return 'Refunded';
  if (value.status === 'APPROVED') return 'Approved';
  return 'Requested';
}

export const VARIABLES: VariableDefinition[] = [
  {
    key: 'username', label: 'Customer first name', description: 'First word of the account name.',
    group: 'customer', type: 'text', fallback: 'Customer', sample: 'Rahul',
    resolve: (c) => firstWord(c.customer?.name),
  },
  {
    key: 'customer_name', label: 'Customer full name', description: 'Account name.',
    group: 'customer', type: 'text', fallback: 'Customer', sample: 'Rahul Sharma',
    resolve: (c) => c.customer?.name || null,
  },
  {
    key: 'customer_email', label: 'Customer email', description: 'Shown in the inbox only; push shows a generic phrase.',
    group: 'customer', type: 'text', sensitive: true, fallback: 'your registered email', sample: 'rahul@example.com',
    resolve: (c) => c.customer?.email || null,
  },
  {
    key: 'customer_mobile', label: 'Customer mobile', description: 'Shown in the inbox only; push shows a generic phrase.',
    group: 'customer', type: 'text', sensitive: true, fallback: 'your mobile number', sample: '9876543210',
    resolve: (c) => c.customer?.mobile || null,
  },
  {
    key: 'order_number', label: 'Order number', description: 'For example DK-20261015-0001.',
    group: 'order', type: 'text', fallback: 'your order', sample: 'DK-20261015-0001',
    resolve: (c) => c.order?.number ?? null,
  },
  {
    key: 'order_status', label: 'Order status', description: 'Placed, Confirmed, Packed, Out for delivery, Delivered…',
    group: 'order', type: 'text', fallback: '', sample: 'Delivered',
    resolve: (c) => (c.order ? orderStatusLabel(c.order.status) : null),
  },
  {
    key: 'order_total', label: 'Order total', description: 'Grand total in rupees.',
    group: 'order', type: 'currency', fallback: '', sample: '₹749.00',
    resolve: (c) => (c.order ? formatInr(c.order.totalPaise) : null),
  },
  {
    key: 'subtotal', label: 'Items subtotal', description: 'Items total before delivery charge.',
    group: 'order', type: 'currency', fallback: '', sample: '₹699.00',
    resolve: (c) => (c.order ? formatInr(c.order.subtotalPaise) : null),
  },
  {
    key: 'delivery_charge', label: 'Delivery charge', description: 'Delivery charge in rupees (₹0.00 when free).',
    group: 'order', type: 'currency', fallback: '', sample: '₹50.00',
    resolve: (c) => (c.order ? formatInr(c.order.deliveryChargePaise) : null),
  },
  {
    key: 'payment_method', label: 'Payment method', description: 'Cash on Delivery.',
    group: 'order', type: 'text', fallback: '', sample: 'Cash on Delivery',
    resolve: (c) => (c.order ? paymentMethodLabel(c.order.paymentMethod) : null),
  },
  {
    key: 'payment_status', label: 'Payment status', description: 'Pending, Collected or Refunded.',
    group: 'order', type: 'text', fallback: '', sample: 'Collected',
    resolve: (c) => (c.order ? paymentStatusLabel(c.order.paymentStatus) : null),
  },
  {
    key: 'order_date', label: 'Order date', description: 'IST calendar date the order was placed.',
    group: 'order', type: 'date', fallback: '', sample: '15 Oct 2026',
    resolve: (c) => (c.order ? formatIstDate(c.order.createdAt) : null),
  },
  {
    key: 'delivery_date', label: 'Delivery date', description: 'IST calendar date of delivery, once delivered.',
    group: 'order', type: 'date', fallback: 'soon', sample: '16 Oct 2026',
    resolve: (c) => (c.order?.deliveredAt ? formatIstDate(c.order.deliveredAt) : null),
  },
  {
    key: 'delivery_address', label: 'Delivery address', description: 'Shown in the inbox only; push shows a generic phrase.',
    group: 'order', type: 'text', sensitive: true, fallback: 'your delivery address', sample: '12 Park Road, Sector 4',
    resolve: (c) => c.order?.address || null,
  },
  {
    key: 'product_summary', label: 'Product summary', description: 'One product name, or "Name and 2 more".',
    group: 'product', type: 'text', fallback: 'your items', sample: 'Pencil Box and 2 more',
    resolve: (c) => productSummary(c),
  },
  {
    key: 'item_count', label: 'Number of products', description: 'Distinct product lines.',
    group: 'product', type: 'number', fallback: '', sample: '3',
    resolve: (c) => ((c.items?.length ?? 0) > 0 ? String(c.items!.length) : null),
  },
  {
    key: 'total_units', label: 'Total units', description: 'Sum of quantities across all lines.',
    group: 'product', type: 'number', fallback: '', sample: '5',
    resolve: (c) => (totalUnits(c) > 0 ? String(totalUnits(c)) : null),
  },
  {
    key: 'product_name', label: 'Product name', description: 'The product; for several lines, the product summary.',
    group: 'product', type: 'text', fallback: 'your items', sample: 'Pencil Box',
    resolve: (c) => productSummary(c),
  },
  {
    key: 'product_quantity', label: 'Product quantity', description: 'Quantity of the single product; total units for several lines.',
    group: 'product', type: 'number', fallback: '', sample: '2',
    resolve: (c) => (totalUnits(c) > 0 ? String(totalUnits(c)) : null),
  },
  {
    key: 'product_price', label: 'Product price', description: 'Unit price when the order has exactly one product line.',
    group: 'product', type: 'currency', fallback: '', sample: '₹349.00',
    resolve: (c) => {
      const item = only(c.items);
      return item && item.unitPricePaise !== null ? formatInr(item.unitPricePaise) : null;
    },
  },
  {
    key: 'pack_label', label: 'Pack label', description: 'Pack or combo label when the order has exactly one product line.',
    group: 'product', type: 'text', fallback: '', sample: 'Pack of 5',
    resolve: (c) => only(c.items)?.packLabel ?? null,
  },
  {
    key: 'return_id', label: 'Return reference', description: 'Short reference of the return or refund case.',
    group: 'return', type: 'text', fallback: 'your request', sample: 'RT-4F2A9C',
    resolve: (c) => (c.return ? `RT-${c.return.id.slice(-6).toUpperCase()}` : null),
  },
  {
    key: 'return_status', label: 'Return status', description: 'Requested, Approved, Rejected or Completed.',
    group: 'return', type: 'text', fallback: '', sample: 'Approved',
    resolve: (c) => (c.return ? returnStatusLabel(c.return.status) : null),
  },
  {
    key: 'refund_amount', label: 'Refund amount', description: 'Approved refund in rupees; the requested amount before approval.',
    group: 'return', type: 'currency', fallback: '', sample: '₹349.00',
    resolve: (c) => (c.return && c.return.refundAmountPaise !== null ? formatInr(c.return.refundAmountPaise) : null),
  },
  {
    key: 'refund_status', label: 'Refund status', description: 'Requested, Approved, Refunded, Rejected or No refund due.',
    group: 'return', type: 'text', fallback: '', sample: 'Refunded',
    resolve: (c) => refundStatus(c),
  },
  {
    key: 'refund_reference', label: 'Refund reference', description: 'Receipt reference recorded when the refund was paid.',
    group: 'return', type: 'text', fallback: '', sample: 'RCPT-1042',
    resolve: (c) => c.return?.reference || null,
  },
  {
    key: 'store_name', label: 'Store name', description: 'The shop name.',
    group: 'store', type: 'text', fallback: 'DoorKart', sample: 'DoorKart',
    resolve: (_c, s) => s.name,
  },
  {
    key: 'support_email', label: 'Support email', description: 'From Settings → Shop details.',
    group: 'store', type: 'text', fallback: 'our support team', sample: 'support@doorkart.in',
    resolve: (_c, s) => s.supportEmail,
  },
  {
    key: 'support_phone', label: 'Support phone', description: 'From Settings → Shop details.',
    group: 'store', type: 'text', fallback: 'our support team', sample: '9876543210',
    resolve: (_c, s) => s.supportPhone,
  },
];

const BY_KEY = new Map(VARIABLES.map((variable) => [variable.key, variable]));

export const getVariable = (key: string): VariableDefinition | undefined => BY_KEY.get(key);

/** A snapshot used for admin preview and test sends: obviously fake but realistic. */
export const SAMPLE_CONTEXT: NotificationContext = {
  customer: { name: 'Rahul Sharma', email: 'rahul@example.com', mobile: '9876543210' },
  order: {
    number: 'DK-20261015-0001', status: 'DELIVERED', paymentMethod: 'COD', paymentStatus: 'COLLECTED',
    subtotalPaise: 69900, deliveryChargePaise: 5000, totalPaise: 74900,
    createdAt: '2026-10-15T06:30:00.000Z', deliveredAt: '2026-10-16T09:00:00.000Z',
    address: '12 Park Road, Sector 4, Pincode 110001',
  },
  items: [

    // Sorted by name, as the context builders produce them.
    { name: 'Gel Pen Set', quantity: 1, unitPricePaise: 15000, packLabel: 'Pack of 5' },
    { name: 'Pencil Box', quantity: 2, unitPricePaise: 34900, packLabel: null },
  ],
  return: { id: 'cmretrn4f2a9c', status: 'COMPLETED', refundAmountPaise: 34900, reference: 'RCPT-1042' },
  productId: 'sample-product',
};

export const SAMPLE_STORE: StoreInfo = {
  name: 'DoorKart', supportEmail: 'support@doorkart.in', supportPhone: '9876543210',
};
