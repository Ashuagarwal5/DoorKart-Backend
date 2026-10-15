import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  getItemAsync: vi.fn(), setItemAsync: vi.fn(), deleteItemAsync: vi.fn(),
}));
vi.mock('../../App/BuyNest/node_modules/expo-secure-store/build/SecureStore.js', () => storage);

import { clearToken, readToken, saveToken } from '../../App/BuyNest/src/features/auth/auth-storage.js';

describe('customer session secure storage', () => {
  beforeEach(() => vi.resetAllMocks());

  it('restores the session using the existing secure-storage key', async () => {
    storage.getItemAsync.mockResolvedValue('test-session');
    expect(await readToken()).toBe('test-session');
    expect(storage.getItemAsync).toHaveBeenCalledWith('doorkart.account-token');
  });

  it('treats an unavailable secure store as signed out', async () => {
    storage.getItemAsync.mockRejectedValue(new Error('unavailable'));
    expect(await readToken()).toBeNull();
  });

  it('confirms a successful session save', async () => {
    storage.setItemAsync.mockResolvedValue(undefined);
    expect(await saveToken('test-session')).toBe(true);
    expect(storage.setItemAsync).toHaveBeenCalledWith('doorkart.account-token', 'test-session');
  });

  it('reports a failed session save instead of pretending it persisted', async () => {
    storage.setItemAsync.mockRejectedValue(new Error('unavailable'));
    expect(await saveToken('test-session')).toBe(false);
  });

  it('confirms that the persisted session was removed', async () => {
    storage.deleteItemAsync.mockResolvedValue(undefined);
    expect(await clearToken()).toBe(true);
    expect(storage.deleteItemAsync).toHaveBeenCalledWith('doorkart.account-token');
  });

  it('reports failed removal so logout can check server revocation', async () => {
    storage.deleteItemAsync.mockRejectedValue(new Error('unavailable'));
    expect(await clearToken()).toBe(false);
  });
});
