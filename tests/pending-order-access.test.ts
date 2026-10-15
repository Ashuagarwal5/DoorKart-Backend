import { describe, expect, it } from 'vitest';

import { keepPendingOrder, pendingOrderAccess } from '../../App/BuyNest/src/features/orders/pending-order-access.js';
import { ApiError, toApiError, toApiErrorCode } from '../../App/BuyNest/src/services/api/api-error.js';

const signedIn = { status: 'signedIn' as const, account: { id: 'account-a' }, token: 'test-session-a' };

describe('pending order account binding', () => {
  it('never retries legacy guest attempts as new orders or assigns them to the current account', () => {
    expect(pendingOrderAccess(undefined, signedIn)).toEqual({ allowed: false });
    expect(pendingOrderAccess(undefined, { status: 'signedOut' })).toEqual({ allowed: false });
  });

  it('uses the original account current session and rejects another account or logout', () => {
    expect(pendingOrderAccess('account-a', signedIn)).toEqual({ allowed: true, token: 'test-session-a' });
    expect(pendingOrderAccess('account-b', signedIn)).toEqual({ allowed: false });
    expect(pendingOrderAccess('account-a', { status: 'signedOut' })).toEqual({ allowed: false });
    expect(pendingOrderAccess('account-a', { status: 'loading' })).toEqual({ allowed: false });
  });

  it.each(['UNAUTHENTICATED', 'IDEMPOTENCY_CONFLICT'] as const)('retains an unresolved authenticated replay on %s', (code) => {
    expect(keepPendingOrder(new ApiError(code), true, 'account-a')).toBe(true);
    expect(keepPendingOrder(new ApiError(code), false, 'account-a')).toBe(false);
  });

  it('retains unknown outcomes and allows definite serviceability refusals to resolve', () => {
    expect(keepPendingOrder(new ApiError('TIMEOUT'), false, 'account-a')).toBe(true);
    expect(keepPendingOrder(new ApiError('DELIVERY_PINCODE_UNSUPPORTED', { status: 422 }), true, 'account-a')).toBe(false);
  });
});

describe('unrecognized order submission outcomes', () => {
  const attempts = [
    { label: 'new guest order', isReplay: false, accountId: undefined },
    { label: 'guest retry', isReplay: true, accountId: undefined },
    { label: 'new account order', isReplay: false, accountId: 'account-a' },
    { label: 'account retry', isReplay: true, accountId: 'account-a' },
  ];

  it.each(attempts)('keeps the original attempt for $label when the outcome is uncertain', ({ isReplay, accountId }) => {
    const errors = [
      new ApiError('UNKNOWN_ERROR'),
      new ApiError(toApiErrorCode('UNRECOGNIZED_SERVER_CODE'), { status: 422 }),
      toApiError(new Error('Unexpected local exception')),
      new ApiError('INTERNAL_ERROR', { status: 500 }),
    ];

    for (const error of errors) {
      expect(error.isOutcomeUnknown).toBe(true);
      expect(keepPendingOrder(error, isReplay, accountId)).toBe(true);
    }
  });

  it.each(attempts)('resolves a definite pincode refusal for $label', ({ isReplay, accountId }) => {
    const error = new ApiError('DELIVERY_PINCODE_UNSUPPORTED', { status: 422 });

    expect(error.isOutcomeUnknown).toBe(false);
    expect(keepPendingOrder(error, isReplay, accountId)).toBe(false);
  });
});
