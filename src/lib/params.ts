import { z } from 'zod';

/** `:id` in a route. Ids are opaque strings, so only length and shape are checked here. */
export const idParamsSchema = z.object({ id: z.string().trim().min(1).max(100) });
