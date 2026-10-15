import { describe, expect, it } from 'vitest';

import { isAddressNext, validateRegistrationForm } from '../../App/BuyNest/src/features/auth/registration-form.js';

const valid = {
  fullName: 'Test Customer',
  email: 'customer@example.test',
  mobile: '+919876543210',
  termsAccepted: true,
};

describe('manual registration form', () => {
  it('prepares a country-coded request without an address or authentication token', () => {
    const result = validateRegistrationForm({
      ...valid,
      fullName: '  Test Customer  ',
      email: ' Customer@Example.test ',
      mobile: '+91 (98765) 43210',
    });
    expect(result).toEqual({ ok: true, input: valid });
  });

  it.each(['9876543210', '+', '+0123456789', '+1234567', '+1234567890123456', '+919876543210x'])('rejects an invalid or missing country code: %s', (mobile) => {
    const result = validateRegistrationForm({ ...valid, mobile });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.mobile).toBeTruthy();
  });

  it.each(['+14155552671', '+447700900123'])('preserves other valid country codes: %s', (mobile) => {
    const result = validateRegistrationForm({ ...valid, mobile });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.mobile).toBe(mobile);
  });

  it('collects all required field errors without creating a request', () => {
    const result = validateRegistrationForm({ fullName: ' ', email: 'invalid', mobile: '', termsAccepted: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors).sort()).toEqual(['email', 'fullName', 'mobile', 'termsAccepted']);
  });

  it('rejects profile values beyond the server limits', () => {
    const result = validateRegistrationForm({ ...valid, fullName: 'x'.repeat(101), email: `${'x'.repeat(190)}@example.test` });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.fullName).toBeTruthy();
      expect(result.errors.email).toBeTruthy();
    }
  });

  it.each([undefined, null, '', '/account', 'https://example.test', ['address'], 'address?email=customer@example.test'])('ignores an unapproved login destination: %s', (next) => {
    expect(isAddressNext(next)).toBe(false);
  });

  it('allows only the address onboarding continuation', () => {
    expect(isAddressNext('address')).toBe(true);
  });
});
