import { describe, expect, it } from 'vitest';

import {
  accountAddressesReducer, emptyAccountAddresses, visibleAccountAddresses,
} from '../../App/BuyNest/src/features/addresses/account-addresses-state.js';
import type { SavedAddress } from '../../App/BuyNest/src/features/addresses/address-types.js';
import { ApiError } from '../../App/BuyNest/src/services/api/api-error.js';

const address = (id: string, isDefault = false): SavedAddress => ({
  id, isDefault, label: 'Home', fullName: 'Buyer', phone: '9876543210', addressLine1: '12 Test Street',
  addressLine2: '', landmark: '', city: 'Testpur', pincode: '226001', deliveryAreaId: 'test-area',
});

const started = () => accountAddressesReducer(emptyAccountAddresses, { type: 'start', sessionKey: 'test-session-a', requestId: 1 });
const loaded = () => accountAddressesReducer(started(), { type: 'loaded', sessionKey: 'test-session-a', requestId: 1, addresses: [address('a', true), address('b')] });

describe('account address session state', () => {
  it('hides the previous account book immediately while the next session loads', () => {
    const state = loaded();
    expect(visibleAccountAddresses(state, 'test-session-b').addresses).toEqual([]);
    const next = accountAddressesReducer(state, { type: 'start', sessionKey: 'test-session-b', requestId: 2 });
    expect(next.addresses).toEqual([]);
    expect(next.isHydrated).toBe(false);
    expect(accountAddressesReducer(next, { type: 'loaded', sessionKey: 'test-session-a', requestId: 1, addresses: [address('private-a')] })).toBe(next);
  });

  it('ignores a stale read that finishes after an address mutation', () => {
    const state = accountAddressesReducer(loaded(), { type: 'start', sessionKey: 'test-session-a', requestId: 2 });
    const saved = accountAddressesReducer(state, { type: 'saved', sessionKey: 'test-session-a', requestId: 2, address: address('c', true) });
    expect(saved.addresses.filter((entry) => entry.isDefault).map((entry) => entry.id)).toEqual(['c']);
    expect(accountAddressesReducer(saved, { type: 'loaded', sessionKey: 'test-session-a', requestId: 1, addresses: [] })).toBe(saved);
  });

  it('clears account data on expiry and ignores late success until a new request starts', () => {
    const expired = accountAddressesReducer(loaded(), { type: 'failed', sessionKey: 'test-session-a', requestId: 1, error: new ApiError('UNAUTHENTICATED') });
    expect(expired.addresses).toEqual([]);
    expect(accountAddressesReducer(expired, { type: 'loaded', sessionKey: 'test-session-a', requestId: 1, addresses: [address('a')] })).toBe(expired);
    expect(accountAddressesReducer(expired, { type: 'reset' })).toEqual(emptyAccountAddresses);
  });

  it('preserves readable account addresses on a temporary API failure', () => {
    const state = loaded();
    const failed = accountAddressesReducer(state, { type: 'failed', sessionKey: 'test-session-a', requestId: 1, error: new ApiError('NETWORK_ERROR') });
    expect(failed.addresses).toEqual(state.addresses);
    expect(failed.error?.code).toBe('NETWORK_ERROR');
  });

  it('keeps address order during an edit and selects a replacement default after deletion', () => {
    const edited = accountAddressesReducer(loaded(), { type: 'saved', sessionKey: 'test-session-a', requestId: 1, address: { ...address('a', true), city: 'New City' } });
    expect(edited.addresses.map((entry) => entry.id)).toEqual(['a', 'b']);
    const removed = accountAddressesReducer(edited, { type: 'removed', sessionKey: 'test-session-a', requestId: 1, id: 'a' });
    expect(removed.addresses).toEqual([address('b', true)]);
  });

  it('rejects mutations from the previous login after logout', () => {
    const signedOut = accountAddressesReducer(loaded(), { type: 'reset' });
    expect(accountAddressesReducer(signedOut, { type: 'saved', sessionKey: 'test-session-a', requestId: 1, address: address('old') })).toBe(signedOut);
  });
});
