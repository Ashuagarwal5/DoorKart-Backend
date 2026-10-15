import { describe, expect, it, vi } from 'vitest';

import { type PurchaseSession, validatePurchaseSession } from '../../App/BuyNest/src/features/auth/purchase-session.js';
import { isCheckoutNext } from '../../App/BuyNest/src/features/auth/registration-form.js';
import { ApiError } from '../../App/BuyNest/src/services/api/api-error.js';

const signedIn = { status: 'signedIn' as const, account: { id: 'buyer-a' }, token: 'test-token-a' };

describe('checkout session validation', () => {
  it.each(['signedOut', 'loading', 'error'] as const)('does not trust a %s session or call the account API', async (status) => {
    const readAccount = vi.fn();
    await expect(validatePurchaseSession({ status }, readAccount, () => signedIn)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(readAccount).not.toHaveBeenCalled();
  });

  it('validates the bearer on the backend rather than trusting a local login flag', async () => {
    const readAccount = vi.fn().mockResolvedValue({ id: 'buyer-a', fullName: 'Buyer' });
    expect(await validatePurchaseSession(signedIn, readAccount, () => signedIn)).toEqual({ account: { id: 'buyer-a', fullName: 'Buyer' }, token: 'test-token-a' });
    expect(readAccount).toHaveBeenCalledWith('test-token-a');
  });

  it.each(['NETWORK_ERROR', 'TIMEOUT', 'UNAUTHENTICATED'] as const)('preserves %s for explicit retry or login handling', async (code) => {
    const error = new ApiError(code);
    await expect(validatePurchaseSession(signedIn, async () => { throw error; }, () => signedIn)).rejects.toBe(error);
    expect(signedIn.token).toBe('test-token-a');
  });

  it.each(['logout', 'account-switch', 'new-session'] as const)('rejects %s while validation is pending', async (kind) => {
    let current: PurchaseSession = signedIn;
    const readAccount = async () => {
      current = kind === 'logout' ? { status: 'signedOut' } : kind === 'account-switch'
        ? { status: 'signedIn', account: { id: 'buyer-b' }, token: 'test-token-b' }
        : { ...signedIn, token: 'new-token-a' };
      return { id: 'buyer-a' };
    };
    await expect(validatePurchaseSession(signedIn, readAccount, () => current)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects an account response that does not match the original session', async () => {
    await expect(validatePurchaseSession(signedIn, async () => ({ id: 'buyer-b' }), () => signedIn)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('allows only the checkout continuation identifier', () => {
    expect(isCheckoutNext('checkout')).toBe(true);
    for (const value of [undefined, '/checkout', ['checkout'], 'https://example.test', 'checkout?placeOrder=true']) expect(isCheckoutNext(value)).toBe(false);
  });
});
