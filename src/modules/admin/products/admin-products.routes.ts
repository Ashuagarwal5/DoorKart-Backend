import { Router } from 'express';

import { sendSuccess } from '../../../lib/http.js';
import { idParamsSchema } from '../../../lib/params.js';
import { getAdmin } from '../../../middleware/admin-auth.js';
import {
  createProductBodySchema,
  inventoryAdjustmentBodySchema,
  listProductsQuerySchema,
  updateProductBodySchema,
} from './admin-products.schemas.js';
import {
  adjustInventory,
  createProduct,
  getProduct,
  listProducts,
  updateProduct,
} from './admin-products.service.js';

export const adminProductsRouter = Router();

adminProductsRouter.get('/', async (req, res) => {
  sendSuccess(res, await listProducts(listProductsQuerySchema.parse(req.query)));
});

adminProductsRouter.post('/', async (req, res) => {
  const body = createProductBodySchema.parse(req.body);
  sendSuccess(res, await createProduct(body, getAdmin(res)), 201);
});

adminProductsRouter.get('/:id', async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);
  sendSuccess(res, await getProduct(id));
});

adminProductsRouter.patch('/:id', async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);
  sendSuccess(res, await updateProduct(id, updateProductBodySchema.parse(req.body)));
});

adminProductsRouter.post('/:id/inventory-adjustment', async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);
  const body = inventoryAdjustmentBodySchema.parse(req.body);
  sendSuccess(res, await adjustInventory(id, body, getAdmin(res)));
});
