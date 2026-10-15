import { describe, expect, it } from 'vitest';

import {
  NOTIFICATION_SCREENS,
  parsePushPayload,
  routeForNotification,
} from '../../App/BuyNest/src/features/notifications/notification-target.js';
import { TARGET_SCREEN_KEYS } from '../src/modules/notifications/targets.js';

describe('notification tap routing (mobile allowlist)', () => {
  it('knows every screen key the server can send', () => {
    expect([...NOTIFICATION_SCREENS].sort()).toEqual([...TARGET_SCREEN_KEYS].sort());
  });

  it('opens an order only for a well-formed order number', () => {
    expect(routeForNotification('ORDER_DETAIL', { orderNumber: 'DK-20261015-0001' })).toEqual({
      pathname: '/orders/[id]',
      params: { id: 'DK-20261015-0001' },
    });
    for (const bad of ['../../admin', 'DK-1', 'javascript:alert(1)', '']) {
      expect(routeForNotification('ORDER_DETAIL', { orderNumber: bad })).toEqual({ pathname: '/notifications' });
    }
    expect(routeForNotification('ORDER_DETAIL', {})).toEqual({ pathname: '/notifications' });
  });

  it('opens a product only for a plain id', () => {
    expect(routeForNotification('PRODUCT', { productId: 'cm123abc' })).toEqual({
      pathname: '/product/[id]',
      params: { id: 'cm123abc' },
    });
    expect(routeForNotification('PRODUCT', { productId: 'a/b' })).toEqual({ pathname: '/notifications' });
  });

  it('sends unknown or hostile screens to the inbox, never to an arbitrary path', () => {
    for (const screen of ['/admin', 'https://evil.example', 'UNKNOWN', '']) {
      expect(routeForNotification(screen, { orderNumber: 'DK-20261015-0001' })).toEqual({ pathname: '/notifications' });
    }
  });
});

describe('push payload validation', () => {
  it('accepts the server payload', () => {
    expect(
      parsePushPayload({ notificationId: 'cmabc12345', eventKey: 'ORDER_DELIVERED', screen: 'ORDER_DETAIL', orderNumber: 'DK-20261015-0001' })
    ).toEqual({
      notificationId: 'cmabc12345',
      screen: 'ORDER_DETAIL',
      params: { orderNumber: 'DK-20261015-0001' },
    });
  });

  it('rejects payloads without a valid notification id or of the wrong shape', () => {
    expect(parsePushPayload(null)).toBeNull();
    expect(parsePushPayload('x')).toBeNull();
    expect(parsePushPayload([])).toBeNull();
    expect(parsePushPayload({})).toBeNull();
    expect(parsePushPayload({ notificationId: 123 })).toBeNull();
    expect(parsePushPayload({ notificationId: '../etc/passwd' })).toBeNull();
  });

  it('ignores non-string and oversized parameters', () => {
    const payload = parsePushPayload({ notificationId: 'cmabc12345', orderNumber: { a: 1 }, productId: 'x'.repeat(200) });
    expect(payload?.params).toEqual({});
  });
});
