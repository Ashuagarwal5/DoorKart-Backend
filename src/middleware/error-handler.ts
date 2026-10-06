import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

import { env } from '../config/env.js';
import { AppError, type ErrorCode } from '../lib/errors.js';

type ErrorBody = {
  success: false;
  error: { code: ErrorCode; message: string; details?: unknown };
};

function errorBody(code: ErrorCode, message: string, details?: unknown): ErrorBody {
  return { success: false, error: { code, message, ...(details === undefined ? {} : { details }) } };
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json(errorBody('ROUTE_NOT_FOUND', `No route for ${req.method} ${req.path}`));
};

/** body-parser reports problems as errors carrying a `type` string. */
function getBodyParserErrorType(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'type' in error) {
    const { type } = error as { type: unknown };
    return typeof type === 'string' ? type : undefined;
  }
  return undefined;
}

/**
 * The only place errors become HTTP responses. Known errors keep their status and code;
 * anything unexpected is logged and returned as a generic 500 with no internals.
 */
// Express identifies error handlers by their four parameters, so `_next` must stay.
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (error instanceof ZodError) {
    const details = error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));
    res.status(400).json(errorBody('VALIDATION_ERROR', 'The request is not valid.', details));
    return;
  }

  if (error instanceof AppError) {
    res.status(error.status).json(errorBody(error.code, error.message, error.details));
    return;
  }

  const bodyParserErrorType = getBodyParserErrorType(error);
  if (bodyParserErrorType === 'entity.parse.failed') {
    res.status(400).json(errorBody('INVALID_JSON', 'The request body is not valid JSON.'));
    return;
  }
  if (bodyParserErrorType === 'entity.too.large') {
    res.status(413).json(errorBody('PAYLOAD_TOO_LARGE', 'The request body is too large.'));
    return;
  }

  // Path only: query strings and headers may carry tracking tokens.
  console.error(`[error] ${req.method} ${req.path}`, error);
  const message =
    !env.isProduction && error instanceof Error ? error.message : 'Something went wrong.';
  res.status(500).json(errorBody('INTERNAL_ERROR', message));
};
