import { type Request, Router } from 'express';

import { AppError } from '../../lib/errors.js';
import { sendSuccess } from '../../lib/http.js';
import {
  createOrderBodySchema,
  orderNumberParamsSchema,
  TRACKING_TOKEN_HEADER,
  trackingTokenSchema,
} from './orders.schemas.js';
import { cancelOrder, createOrder, getOrder } from './orders.service.js';

export const ordersRouter = Router();

function readTrackingToken(req: Request): string {
  const token = trackingTokenSchema.safeParse(req.get(TRACKING_TOKEN_HEADER));
  if (!token.success) {
    throw new AppError(
      401,
      'INVALID_TRACKING_TOKEN',
      `Send the order's tracking token in the ${TRACKING_TOKEN_HEADER} header.`
    );
  }
  return token.data;
}

ordersRouter.post('/orders', async (req, res) => {
  const input = createOrderBodySchema.parse(req.body);
  const { order, created } = await createOrder(input);

  // A replayed clientRequestId answers 200 with the original order instead of 201.
  if (!created) {
    res.set('Idempotent-Replayed', 'true');
  }
  sendSuccess(res, order, created ? 201 : 200);
});

ordersRouter.get('/orders/:orderNumber', async (req, res) => {
  const { orderNumber } = orderNumberParamsSchema.parse(req.params);
  sendSuccess(res, await getOrder(orderNumber, readTrackingToken(req)));
});

ordersRouter.post('/orders/:orderNumber/cancel', async (req, res) => {
  const { orderNumber } = orderNumberParamsSchema.parse(req.params);
  sendSuccess(res, await cancelOrder(orderNumber, readTrackingToken(req)));
});
