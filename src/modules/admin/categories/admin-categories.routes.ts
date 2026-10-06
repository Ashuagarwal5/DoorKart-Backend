import { Router } from 'express';

import { sendSuccess } from '../../../lib/http.js';
import { idParamsSchema } from '../../../lib/params.js';
import { createCategoryBodySchema, updateCategoryBodySchema } from './admin-categories.schemas.js';
import { createCategory, listCategories, updateCategory } from './admin-categories.service.js';

export const adminCategoriesRouter = Router();

adminCategoriesRouter.get('/', async (_req, res) => {
  sendSuccess(res, await listCategories());
});

adminCategoriesRouter.post('/', async (req, res) => {
  sendSuccess(res, await createCategory(createCategoryBodySchema.parse(req.body)), 201);
});

adminCategoriesRouter.patch('/:id', async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);
  sendSuccess(res, await updateCategory(id, updateCategoryBodySchema.parse(req.body)));
});
