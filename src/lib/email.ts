/** Emails are stored and compared lower-cased and trimmed, so "Owner@Shop.com " is "owner@shop.com". */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
