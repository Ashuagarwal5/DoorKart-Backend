import { Router } from 'express';

import { requireAdmin, requireTrustedOrigin } from '../../middleware/admin-auth.js';
import { adminCategoriesRouter } from './categories/admin-categories.routes.js';
import { adminCustomersRouter } from './customers/admin-customers.module.js';
import { adminDashboardRouter } from './dashboard/admin-dashboard.module.js';
import { adminDeliveryAreasRouter } from './delivery-areas/admin-delivery-areas.module.js';
import { createAdminAuthRouter, type LoginRateLimit } from './auth/admin-auth.routes.js';
import { adminOrdersRouter } from './orders/admin-orders.routes.js';
import { adminProductsRouter } from './products/admin-products.routes.js';
import { adminSettingsRouter } from './settings/admin-settings.routes.js';
import { adminUploadsRouter } from './uploads/admin-uploads.routes.js';

/**
 * Everything under /api/v1/admin. The order of the lines is the security model:
 *   1. a browser request that changes something must come from an allowed origin;
 *   2. /auth is reachable without signing in (login has to be);
 *   3. every route after the `requireAdmin` line needs a valid admin session.
 * A new admin route added below that line is protected without doing anything.
 */
export function createAdminRouter(loginRateLimit: LoginRateLimit) {
  const router = Router();

  router.use(requireTrustedOrigin);
  router.use('/auth', createAdminAuthRouter(loginRateLimit));

  router.use(requireAdmin);
  router.use('/dashboard', adminDashboardRouter);
  router.use('/orders', adminOrdersRouter);
  router.use('/products', adminProductsRouter);
  router.use('/categories', adminCategoriesRouter);
  router.use('/delivery-areas', adminDeliveryAreasRouter);
  router.use('/customers', adminCustomersRouter);
  router.use('/uploads', adminUploadsRouter);
  router.use('/settings', adminSettingsRouter);

  return router;
}
