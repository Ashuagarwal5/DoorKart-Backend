/** Every error code the API can return. Clients switch on these, not on messages. */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_JSON'
  | 'PAYLOAD_TOO_LARGE'
  | 'ROUTE_NOT_FOUND'
  | 'CATEGORY_NOT_FOUND'
  | 'PRODUCT_NOT_FOUND'
  | 'PRODUCT_UNAVAILABLE'
  | 'DELIVERY_AREA_NOT_FOUND'
  | 'DELIVERY_AREA_UNAVAILABLE'
  | 'OUT_OF_STOCK'
  | 'MINIMUM_ORDER_NOT_MET'
  | 'ORDER_NOT_FOUND'
  | 'INVALID_TRACKING_TOKEN'
  | 'ORDER_CANNOT_BE_CANCELLED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'ORIGIN_NOT_ALLOWED'
  | 'TOO_MANY_REQUESTS'
  | 'INVALID_ORDER_TRANSITION'
  | 'PAYMENT_NOT_ALLOWED'
  | 'INVALID_PAYMENT_TRANSITION'
  | 'INVENTORY_MISMATCH'
  | 'ADJUSTMENT_BELOW_RESERVED'
  | 'CUSTOMER_NOT_FOUND'
  | 'DUPLICATE_SKU'
  | 'DUPLICATE_SLUG'
  | 'DUPLICATE_NAME'
  | 'UNSUPPORTED_MEDIA'
  | 'SECRETS_NOT_CONFIGURED'
  | 'EMAIL_NOT_CONFIGURED'
  | 'EMAIL_SEND_FAILED'
  | 'GOOGLE_NOT_CONFIGURED'
  | 'INVALID_OTP'
  | 'INVALID_GOOGLE_TOKEN'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

/**
 * An expected failure with a deliberate HTTP status and code. Services throw these;
 * the central error handler turns them into the standard error response.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    /** Extra machine-readable context that is safe to show the client. */
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (code: ErrorCode, message: string) => new AppError(404, code, message);

/** No valid sign-in. The client should send the user to the login screen. */
export const unauthenticated = (message = 'Please sign in to continue.') =>
  new AppError(401, 'UNAUTHENTICATED', message);

/** Signed in, but this account may not do this. */
export const forbidden = (message = 'You do not have permission to do this.') =>
  new AppError(403, 'FORBIDDEN', message);

/** The request is valid but conflicts with current state (stock, order status...). */
export const conflict = (code: ErrorCode, message: string, details?: unknown) =>
  new AppError(409, code, message, details);

/** The request is well-formed but breaks a business rule. */
export const unprocessable = (code: ErrorCode, message: string, details?: unknown) =>
  new AppError(422, code, message, details);
