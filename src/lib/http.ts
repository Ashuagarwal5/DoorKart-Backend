import type { Response } from 'express';

/** Standard success envelope: `{ "success": true, "data": ... }`. */
export function sendSuccess(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ success: true, data });
}
