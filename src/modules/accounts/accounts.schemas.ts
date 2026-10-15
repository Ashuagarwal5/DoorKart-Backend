import { z } from 'zod';

import { normalizeEmail } from '../../lib/email.js';

export const accountEmailSchema = z.string().trim().min(3).max(200).pipe(z.email()).transform(normalizeEmail);
export const accountMobileSchema = z.string().trim().max(30).transform((value) => value.replace(/[\s()-]/g, ''))
  .pipe(z.string().regex(/^\+[1-9]\d{7,14}$/, 'Enter a mobile number with its country code, for example +91 9876543210'));

export const registrationBodySchema = z.strictObject({
  email: accountEmailSchema,
  fullName: z.string().trim().min(2).max(100),
  mobile: accountMobileSchema,
  termsAccepted: z.literal(true, { error: 'Accept the Terms and Privacy Policy to register' }),
});

export type RegistrationInput = z.infer<typeof registrationBodySchema>;

export const registrationDataSchema = z.strictObject({
  fullName: z.string().trim().min(2).max(100),
  mobile: accountMobileSchema,
  termsAcceptedAt: z.iso.datetime(),
});
