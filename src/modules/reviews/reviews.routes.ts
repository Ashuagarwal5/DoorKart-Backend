import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { sendSuccess } from '../../lib/http.js';
import { idParamsSchema } from '../../lib/params.js';
import { getAccount } from '../../middleware/account-auth.js';
import { getAdmin } from '../../middleware/admin-auth.js';
import { adminQuery, manualBody, moderationBody, ownQuery, productParams, publicQuery, reviewBody } from './reviews.schemas.js';
import { adminReviews, deleteReview, editReview, manualReview, moderateReview, myReviews, publicReviews, reviewEligibility, submitReview } from './reviews.service.js';

export const publicReviewsRouter = Router();
export const accountReviewsRouter = Router();
export const adminReviewsRouter = Router();
const reviewLimiter = rateLimit({ windowMs: 3600000, limit: 30, skip: () => env.isTest, standardHeaders: true, legacyHeaders: false,
  handler: (_req, _res, next) => next(new AppError(429, 'TOO_MANY_REQUESTS', 'Too many review changes. Please try again later.')) });
publicReviewsRouter.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
publicReviewsRouter.get('/products/:productId/reviews', async (req, res) => {
  sendSuccess(res, await publicReviews(productParams.parse(req.params).productId, publicQuery.parse(req.query)));
});
// Mounted behind the existing account session middleware; identity never comes from the body.
accountReviewsRouter.get('/', async (req, res) => sendSuccess(res, await myReviews(getAccount(res).id, ownQuery.parse(req.query))));
accountReviewsRouter.get('/product/:productId', async (req, res) => sendSuccess(res, await reviewEligibility(productParams.parse(req.params).productId, getAccount(res).id)));
accountReviewsRouter.post('/product/:productId', reviewLimiter, async (req, res) => sendSuccess(res, await submitReview(productParams.parse(req.params).productId, getAccount(res).id, reviewBody.parse(req.body)), 201));
accountReviewsRouter.patch('/:id', reviewLimiter, async (req, res) => sendSuccess(res, await editReview(idParamsSchema.parse(req.params).id, getAccount(res).id, reviewBody.parse(req.body))));
accountReviewsRouter.delete('/:id', reviewLimiter, async (req, res) => sendSuccess(res, await deleteReview(idParamsSchema.parse(req.params).id, getAccount(res).id)));
// Mounted behind admin cookie authentication and the existing trusted-origin check.
adminReviewsRouter.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
adminReviewsRouter.get('/', async (req, res) => sendSuccess(res, await adminReviews(adminQuery.parse(req.query))));
adminReviewsRouter.post('/', async (req, res) => sendSuccess(res, await manualReview(getAdmin(res).id, manualBody.parse(req.body)), 201));
adminReviewsRouter.post('/:id/moderate', async (req, res) => {
  const { action, note } = moderationBody.parse(req.body);
  sendSuccess(res, await moderateReview(idParamsSchema.parse(req.params).id, getAdmin(res).id, action, note));
});
