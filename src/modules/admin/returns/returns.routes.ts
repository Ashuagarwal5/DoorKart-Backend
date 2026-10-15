import { Router } from 'express';
import { sendSuccess } from '../../../lib/http.js';
import { idParamsSchema } from '../../../lib/params.js';
import { getAdmin } from '../../../middleware/admin-auth.js';
import { createReturnBody, reconciliationQuery, returnActionBody, returnListQuery } from './returns.schemas.js';
import { actOnReturn, createReturn, getReturn, listReturns, orderReturns, reconciliation } from './returns.service.js';

// Mounted behind requireAdmin and trusted-origin middleware. Both existing staff roles can act.
export const adminReturnsRouter = Router();
adminReturnsRouter.use((_req,res,next) => { res.set('Cache-Control','no-store'); next(); });
adminReturnsRouter.get('/', async (req,res) => sendSuccess(res, await listReturns(returnListQuery.parse(req.query))));
adminReturnsRouter.get('/reconciliation', async (req,res) => { const q = reconciliationQuery.parse(req.query); sendSuccess(res, await reconciliation(q.from,q.to)); });
adminReturnsRouter.get('/order/:id', async (req,res) => sendSuccess(res, await orderReturns(idParamsSchema.parse(req.params).id)));
adminReturnsRouter.get('/:id', async (req,res) => sendSuccess(res, await getReturn(idParamsSchema.parse(req.params).id)));
adminReturnsRouter.post('/', async (req,res) => sendSuccess(res, await createReturn(createReturnBody.parse(req.body),getAdmin(res)),201));
adminReturnsRouter.post('/:id/actions', async (req,res) => sendSuccess(res, await actOnReturn(idParamsSchema.parse(req.params).id,returnActionBody.parse(req.body),getAdmin(res))));
