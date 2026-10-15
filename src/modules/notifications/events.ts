import type { TargetScreen } from './targets.js';
import type { VariableGroup } from './variables.js';

/**
 * The one list of business events that can notify a customer. Event keys are referenced
 * through EVENT_KEYS everywhere else; no other file spells an event name out. Adding an
 * event means adding one entry here and calling `enqueueNotificationEvent` where the
 * business transition commits.
 */

export const EVENT_KEYS = {
  ORDER_PLACED: 'ORDER_PLACED',
  ORDER_CONFIRMED: 'ORDER_CONFIRMED',
  ORDER_PACKED: 'ORDER_PACKED',
  ORDER_OUT_FOR_DELIVERY: 'ORDER_OUT_FOR_DELIVERY',
  ORDER_DELIVERED: 'ORDER_DELIVERED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  ORDER_DELIVERY_FAILED: 'ORDER_DELIVERY_FAILED',
  PAYMENT_COLLECTED: 'PAYMENT_COLLECTED',
  REFUND_COMPLETED: 'REFUND_COMPLETED',
  RETURN_REQUESTED: 'RETURN_REQUESTED',
  RETURN_APPROVED: 'RETURN_APPROVED',
  RETURN_REJECTED: 'RETURN_REJECTED',
  RETURN_COMPLETED: 'RETURN_COMPLETED',
  ACCOUNT_REGISTERED: 'ACCOUNT_REGISTERED',
  REVIEW_APPROVED: 'REVIEW_APPROVED',
  REVIEW_REJECTED: 'REVIEW_REJECTED',
} as const;

export type EventKey = (typeof EVENT_KEYS)[keyof typeof EVENT_KEYS];

export type EventDefinition = {
  key: EventKey;
  name: string;
  description: string;
  group: 'Orders' | 'Payments' | 'Returns' | 'Account' | 'Reviews';
  /** Variable groups a template for this event may use. */
  variableGroups: readonly VariableGroup[];
  defaultTarget: TargetScreen;
  /** How the recipient is found. Always an account; never an id supplied by a client. */
  recipient: 'order.account' | 'review.account' | 'account';
};

const order = ['customer', 'order', 'product', 'store'] as const;
const returns = ['customer', 'order', 'product', 'return', 'store'] as const;

export const EVENT_DEFINITIONS: readonly EventDefinition[] = [
  { key: EVENT_KEYS.ORDER_PLACED, name: 'Order placed', group: 'Orders', description: 'A signed-in customer placed an order. Not sent again for an idempotent retry.', variableGroups: order, defaultTarget: 'ORDER_DETAIL', recipient: 'order.account' },
  { key: EVENT_KEYS.ORDER_CONFIRMED, name: 'Order confirmed', group: 'Orders', description: 'The shop confirmed the order.', variableGroups: order, defaultTarget: 'ORDER_DETAIL', recipient: 'order.account' },
  { key: EVENT_KEYS.ORDER_PACKED, name: 'Order packed', group: 'Orders', description: 'The order was packed.', variableGroups: order, defaultTarget: 'ORDER_DETAIL', recipient: 'order.account' },
  { key: EVENT_KEYS.ORDER_OUT_FOR_DELIVERY, name: 'Out for delivery', group: 'Orders', description: 'The order left for delivery (also after a failed attempt).', variableGroups: order, defaultTarget: 'ORDER_DETAIL', recipient: 'order.account' },
  { key: EVENT_KEYS.ORDER_DELIVERED, name: 'Order delivered', group: 'Orders', description: 'The order was marked delivered.', variableGroups: order, defaultTarget: 'ORDER_DETAIL', recipient: 'order.account' },
  { key: EVENT_KEYS.ORDER_CANCELLED, name: 'Order cancelled', group: 'Orders', description: 'The order was cancelled by the shop or the customer.', variableGroups: order, defaultTarget: 'ORDER_DETAIL', recipient: 'order.account' },
  { key: EVENT_KEYS.ORDER_DELIVERY_FAILED, name: 'Delivery failed', group: 'Orders', description: 'A delivery attempt failed; the order stays open.', variableGroups: order, defaultTarget: 'ORDER_DETAIL', recipient: 'order.account' },
  { key: EVENT_KEYS.PAYMENT_COLLECTED, name: 'Cash collected', group: 'Payments', description: 'Cash on delivery was recorded as collected.', variableGroups: order, defaultTarget: 'ORDER_DETAIL', recipient: 'order.account' },
  { key: EVENT_KEYS.REFUND_COMPLETED, name: 'Refund completed', group: 'Payments', description: 'A cash refund was paid and the case completed.', variableGroups: returns, defaultTarget: 'ORDER_DETAIL', recipient: 'order.account' },
  { key: EVENT_KEYS.RETURN_REQUESTED, name: 'Return opened', group: 'Returns', description: 'The shop opened a return/refund case for the order. Customers cannot open one themselves.', variableGroups: returns, defaultTarget: 'ORDER_DETAIL', recipient: 'order.account' },
  { key: EVENT_KEYS.RETURN_APPROVED, name: 'Return approved', group: 'Returns', description: 'A return/refund case was approved.', variableGroups: returns, defaultTarget: 'ORDER_DETAIL', recipient: 'order.account' },
  { key: EVENT_KEYS.RETURN_REJECTED, name: 'Return rejected', group: 'Returns', description: 'A return/refund case was rejected.', variableGroups: returns, defaultTarget: 'ORDER_DETAIL', recipient: 'order.account' },
  { key: EVENT_KEYS.RETURN_COMPLETED, name: 'Return completed', group: 'Returns', description: 'A return/refund case was completed (also when the case has no cash refund).', variableGroups: returns, defaultTarget: 'ORDER_DETAIL', recipient: 'order.account' },
  { key: EVENT_KEYS.ACCOUNT_REGISTERED, name: 'Account registered', group: 'Account', description: 'A new account was created and verified.', variableGroups: ['customer', 'store'], defaultTarget: 'HOME', recipient: 'account' },
  { key: EVENT_KEYS.REVIEW_APPROVED, name: 'Review approved', group: 'Reviews', description: 'A customer review was approved by the shop.', variableGroups: ['customer', 'product', 'store'], defaultTarget: 'PRODUCT', recipient: 'review.account' },
  { key: EVENT_KEYS.REVIEW_REJECTED, name: 'Review rejected', group: 'Reviews', description: 'A customer review was rejected by the shop.', variableGroups: ['customer', 'product', 'store'], defaultTarget: 'MY_REVIEWS', recipient: 'review.account' },
];

const BY_KEY = new Map<string, EventDefinition>(EVENT_DEFINITIONS.map((event) => [event.key, event]));

export const getEvent = (key: string): EventDefinition | undefined => BY_KEY.get(key);
export const isEventKey = (key: string): key is EventKey => BY_KEY.has(key);
