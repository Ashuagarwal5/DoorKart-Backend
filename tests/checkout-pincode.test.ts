import { describe, expect, it } from 'vitest';

import { emptyCheckoutDetails, validateCheckoutDetails } from '../../App/BuyNest/src/features/checkout/checkout-details.js';
import { ApiError, toApiErrorCode } from '../../App/BuyNest/src/services/api/api-error.js';

const details = { ...emptyCheckoutDetails, pincode: '226001', deliveryAreaId: 'test-area' };

describe('checkout pincode feedback', () => {
  it('accepts a matching trimmed pincode', () => {
    expect(validateCheckoutDetails({ ...details, pincode: ' 226001 ' }, { pincode: '226001' }).pincode).toBeUndefined();
  });

  it.each(['226002', null, undefined])('explains unavailable delivery for configured pincode %s', (pincode) => {
    expect(validateCheckoutDetails(details, { pincode }).pincode).toContain('Delivery is unavailable');
  });

  it.each(['', '012345', '12345', 'ABCDEF'])('keeps format validation for %s', (pincode) => {
    expect(validateCheckoutDetails({ ...details, pincode }, { pincode: '226001' }).pincode).toBeTruthy();
  });

  it('recognizes a server refusal as definite and provides actionable feedback', () => {
    const code = toApiErrorCode('DELIVERY_PINCODE_UNSUPPORTED');
    expect(code).toBe('DELIVERY_PINCODE_UNSUPPORTED');
    const error = new ApiError(code, { status: 422 });
    expect(error.message).toContain('choose another delivery area');
    expect(error.isOutcomeUnknown).toBe(false);
  });
});
