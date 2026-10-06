const MOBILE_PATTERN = /^[6-9]\d{9}$/;

/**
 * The digits to look for when someone types a phone number into a search box, or null if
 * there is nothing worth searching on. Numbers are stored as 10 plain digits, so a full
 * number typed with "+91", spaces or a leading 0 is reduced to those 10 digits; a partial
 * number ("987") is searched as the digits typed.
 */
export function phoneSearchDigits(input: string): string | null {
  const full = normalizeIndianMobile(input);
  if (full !== null) {
    return full;
  }
  const digits = input.replace(/\D/g, '');
  return digits.length >= 3 ? digits : null;
}

/**
 * Returns the 10-digit Indian mobile number, or null if the input is not one.
 * Accepts spaces, dashes, brackets and a leading +91, 91 or 0. Customers are keyed by
 * this normalized form, so "+91 98765 43210" and "09876543210" are the same customer.
 */
export function normalizeIndianMobile(input: string): string | null {
  let digits = input.replace(/[\s()-]/g, '');
  if (digits.startsWith('+91')) {
    digits = digits.slice(3);
  } else if (digits.length === 12 && digits.startsWith('91')) {
    digits = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }
  return MOBILE_PATTERN.test(digits) ? digits : null;
}
