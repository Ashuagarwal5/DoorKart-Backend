import { describe, expect, it } from 'vitest';

import { validatePurchaseSession } from '../../App/BuyNest/src/features/auth/purchase-session.js';
import { cartReducer, initialCartState } from '../../App/BuyNest/src/features/cart/cart-reducer.js';
import { ApiError } from '../../App/BuyNest/src/services/api/api-error.js';
import type { Product } from '../../App/BuyNest/src/types/catalog.js';

const product: Product = { id: 'notebook', name: 'Notebook', slug: 'notebook', description: '',
  categoryId: 'stationery', categorySlug: 'stationery', categoryName: 'Stationery', images: [],
  mrp: 39900, sellingPrice: 34900, stockQuantity: 10, isFeatured: false, isNew: false };
const signedIn = { status: 'signedIn' as const, account: { id: 'buyer-a' }, token: 'test-session' };

describe('cart continuity through authentication', () => {
  it('allows guest additions and preserves product selections and quantities on hydration', () => {
    const guestCart = cartReducer(initialCartState, { type: 'add', product, quantity: 3 });
    const persisted = JSON.parse(JSON.stringify(guestCart.entries)) as typeof guestCart.entries;
    expect(cartReducer(initialCartState, { type: 'hydrate', entries: persisted })).toEqual(guestCart);
    expect(guestCart.entries).toHaveLength(1);
    expect(guestCart.entries[0]?.quantity).toBe(3);
  });

  it.each(['NETWORK_ERROR', 'UNAUTHENTICATED'] as const)('preserves a cart when session validation fails with %s', async (code) => {
    const cart = cartReducer(initialCartState, { type: 'add', product, quantity: 2 });
    const before = JSON.stringify(cart);
    await expect(validatePurchaseSession(signedIn, async () => { throw new ApiError(code); }, () => signedIn)).rejects.toMatchObject({ code });
    expect(JSON.stringify(cart)).toBe(before);
  });

  it('keeps quantities on successful validation and refreshes prices without adding duplicate lines', async () => {
    const cart = cartReducer(initialCartState, { type: 'add', product, quantity: 2 });
    await validatePurchaseSession(signedIn, async () => ({ id: 'buyer-a' }), () => signedIn);
    const refreshed = cartReducer(cart, { type: 'sync', products: [{ ...product, sellingPrice: 35900 }], unavailableIds: [] });
    expect(refreshed.entries).toHaveLength(1);
    expect(refreshed.entries[0]).toMatchObject({ quantity: 2, product: { id: 'notebook', sellingPrice: 35900 } });
  });
});
