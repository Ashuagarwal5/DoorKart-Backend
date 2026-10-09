import { Router } from 'express';

import { sendSuccess } from '../../lib/http.js';
import { listProductsQuerySchema, productIdentifierParamsSchema } from './catalog.schemas.js';
import { readSettings, shopInfo } from '../settings/settings.service.js';
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

/** The shop's public contact details, edited in the admin panel under Settings. */
catalogRouter.get('/shop', async (_req, res) => {
  sendSuccess(res, shopInfo(await readSettings()));
});

catalogRouter.get('/delivery-areas', async (_req, res) => {
  sendSuccess(res, await listDeliveryAreas());
});
