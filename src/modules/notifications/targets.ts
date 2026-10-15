import type { NotificationContext } from './context.js';

/**
 * Where a tapped notification may take the customer. This is an allowlist: a template can
 * only name a key from this list, and the mobile app maps each key to a route it already
 * owns. A target never carries a URL.
 */
export const TARGET_SCREENS = {
  ORDER_DETAIL: { label: 'Order details', requires: 'orderNumber' },
  PRODUCT: { label: 'Product', requires: 'productId' },
  MY_REVIEWS: { label: 'My reviews', requires: null },
  ORDERS: { label: 'My orders', requires: null },
  NOTIFICATIONS: { label: 'Notifications', requires: null },
  HOME: { label: 'Home', requires: null },
} as const;

export type TargetScreen = keyof typeof TARGET_SCREENS;
export const TARGET_SCREEN_KEYS = Object.keys(TARGET_SCREENS) as TargetScreen[];

export function isTargetScreen(value: string): value is TargetScreen {
  return Object.hasOwn(TARGET_SCREENS, value);
}

export type ResolvedTarget = { screen: TargetScreen; params: Record<string, string> };

/** Resolves the screen and its parameters from the snapshot; falls back to the inbox. */
export function resolveTarget(screen: TargetScreen, context: NotificationContext): ResolvedTarget {
  const requires = TARGET_SCREENS[screen].requires;
  if (requires === null) return { screen, params: {} };
  if (requires === 'orderNumber' && context.order?.number) {
    return { screen, params: { orderNumber: context.order.number } };
  }
  if (requires === 'productId' && context.productId) {
    return { screen, params: { productId: context.productId } };
  }
  return { screen: 'NOTIFICATIONS', params: {} };
}
