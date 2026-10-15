import { describe, expect, it } from 'vitest';

import { accountOrdersReducer, emptyAccountOrders } from '../../App/BuyNest/src/features/orders/account-orders-state.js';
import { ApiError } from '../../App/BuyNest/src/services/api/api-error.js';
import type { Order } from '../../App/BuyNest/src/types/order.js';

function order(orderNumber: string): Order {
  return {
    orderNumber, customerName: 'Buyer', customerPhone: '9876543210',
    deliveryAddress: { addressLine1: '1 Road', addressLine2: null, landmark: null, area: 'Area', city: 'City', pincode: '226001' },
    items: [], subtotal: 100, deliveryCharge: 0, discount: 0, grandTotal: 100,
    paymentMethod: 'COD', paymentStatus: 'PENDING', orderStatus: 'PLACED', statusHistory: [], createdAt: '2026-10-12T00:00:00.000Z',
  };
}

function populated() {
  const loading = accountOrdersReducer(emptyAccountOrders, { type: 'start', sessionKey: 'session-a', requestId: 1, page: 1 });
  return accountOrdersReducer(loading, { type: 'loaded', sessionKey: 'session-a', requestId: 1,
    items: [order('DK-20261012-1001')], page: 1, hasMore: true });
}

describe('mobile account history isolation', () => {
  it('shows a newly confirmed account purchase and removes it from the session on logout', () => {
    const created = accountOrdersReducer(populated(), { type: 'detailLoaded', sessionKey: 'session-a', order: order('DK-20261012-1002') });
    expect(created.items[0]?.orderNumber).toBe('DK-20261012-1002');
    expect(created.details['DK-20261012-1002']?.order).toBeDefined();
    expect(accountOrdersReducer(created, { type: 'reset' })).toEqual(emptyAccountOrders);
  });

  it('clears account history on logout and ignores late list/detail responses', () => {
    const cleared = accountOrdersReducer(populated(), { type: 'reset' });
    expect(cleared.items).toEqual([]);
    expect(cleared.details).toEqual({});
    expect(accountOrdersReducer(cleared, { type: 'loaded', sessionKey: 'session-a', requestId: 1,
      items: [order('DK-20261012-1001')], page: 1, hasMore: false })).toEqual(cleared);
    expect(accountOrdersReducer(cleared, { type: 'detailLoaded', sessionKey: 'session-a', order: order('DK-20261012-1001') })).toEqual(cleared);
  });

  it('starts a fresh cache for another login and rejects stale responses', () => {
    const switched = accountOrdersReducer(populated(), { type: 'start', sessionKey: 'session-b', requestId: 2, page: 1 });
    expect(switched.items).toEqual([]);
    expect(switched.details).toEqual({});
    expect(accountOrdersReducer(switched, { type: 'detailLoaded', sessionKey: 'session-a', order: order('DK-20261012-1001') })).toEqual(switched);
  });

  it('ignores an older refresh for the same session', () => {
    const refresh = accountOrdersReducer(populated(), { type: 'start', sessionKey: 'session-a', requestId: 2, page: 1 });
    expect(accountOrdersReducer(refresh, { type: 'loaded', sessionKey: 'session-a', requestId: 1,
      items: [], page: 1, hasMore: false })).toEqual(refresh);
  });

  it('deduplicates paginated orders and represents an empty account history', () => {
    const more = accountOrdersReducer(populated(), { type: 'start', sessionKey: 'session-a', requestId: 2, page: 2 });
    const next = accountOrdersReducer(more, { type: 'loaded', sessionKey: 'session-a', requestId: 2,
      items: [order('DK-20261012-1001'), order('DK-20261012-1002')], page: 2, hasMore: false });
    expect(next.items).toHaveLength(2);
    expect(next.hasMore).toBe(false);
    const loading = accountOrdersReducer(next, { type: 'start', sessionKey: 'session-a', requestId: 3, page: 1 });
    const empty = accountOrdersReducer(loading, { type: 'loaded', sessionKey: 'session-a', requestId: 3, items: [], page: 1, hasMore: false });
    expect(empty.items).toEqual([]);
    expect(empty.status).toBe('ready');
  });

  it('keeps readable history on a transient API failure', () => {
    const failed = accountOrdersReducer(populated(), { type: 'failed', sessionKey: 'session-a', requestId: 1, error: new ApiError('NETWORK_ERROR') });
    expect(failed.items).toHaveLength(1);
    expect(failed.error?.code).toBe('NETWORK_ERROR');
  });

  it('hides orders after session expiry and ignores late successful responses', () => {
    const expired = accountOrdersReducer(populated(), { type: 'failed', sessionKey: 'session-a', requestId: 1,
      error: new ApiError('UNAUTHENTICATED', { status: 401 }) });
    expect(expired.items).toEqual([]);
    expect(expired.details).toEqual({});
    expect(accountOrdersReducer(expired, { type: 'detailLoaded', sessionKey: 'session-a', order: order('DK-20261012-1001') })).toEqual(expired);
  });
});
