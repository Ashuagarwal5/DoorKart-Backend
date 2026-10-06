import { Router } from 'express';

import { sendSuccess } from '../../../lib/http.js';
import { idParamsSchema } from '../../../lib/params.js';
import { getAdmin } from '../../../middleware/admin-auth.js';
import {
  changeOrderStatusBodySchema,
  listOrdersQuerySchema,
  recordPaymentBodySchema,
} from './admin-orders.schemas.js';
import {
  changeOrderStatus,
  getOrderDetail,
  listOrders,
  recordPayment,
} from './admin-orders.service.js';

export const adminOrdersRouter = Router();

adminOrdersRouter.get('/', async (req, res) => {
  sendSuccess(res, await listOrders(listOrdersQuerySchema.parse(req.query)));
});

adminOrdersRouter.get('/:id', async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);
  sendSuccess(res, await getOrderDetail(id));
});

adminOrdersRouter.patch('/:id/status', async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);
  const body = changeOrderStatusBodySchema.parse(req.body);
  sendSuccess(res, await changeOrderStatus(id, body.status, body.note, getAdmin(res)));
});

adminOrdersRouter.patch('/:id/payment', async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);
  const body = recordPaymentBodySchema.parse(req.body);
  sendSuccess(res, await recordPayment(id, body.paymentStatus, body.note, getAdmin(res)));
});
