import { Router } from 'express';

import { sendSuccess } from '../../lib/http.js';
import { listProductsQuerySchema, productIdentifierParamsSchema } from './catalog.schemas.js';
import { getProduct, listCategories, listDeliveryAreas, listProducts } from './catalog.service.js';

export const catalogRouter = Router();

catalogRouter.get('/categories', async (_req, res) => {
  sendSuccess(res, await listCategories());
});

catalogRouter.get('/products', async (req, res) => {
  const query = listProductsQuerySchema.parse(req.query);
  sendSuccess(res, await listProducts(query));
});

catalogRouter.get('/products/:identifier', async (req, res) => {
  const { identifier } = productIdentifierParamsSchema.parse(req.params);
  sendSuccess(res, await getProduct(identifier));
});

catalogRouter.get('/delivery-areas', async (_req, res) => {
  sendSuccess(res, await listDeliveryAreas());
});
