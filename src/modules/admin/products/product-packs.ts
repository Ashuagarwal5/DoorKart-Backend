import { z } from 'zod';
import { conflict, notFound } from '../../../lib/errors.js';
import { prisma, type TransactionClient } from '../../../lib/prisma.js';

const units = z.number().int().min(1).max(10000);
export const comboComponentsSchema = z.array(z.strictObject({ productId: z.string().trim().min(1).max(100), quantity: units })).min(2).max(30).refine(rows => new Set(rows.map(r => r.productId)).size === rows.length, 'Each component product may appear once');
const prices = { mrpPaise: z.number().int().min(0).max(100000000), sellingPricePaise: z.number().int().min(0).max(100000000) };
const fields = { label: z.string().trim().min(1).max(100), sku: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/), ...prices, isActive: z.boolean(), displayOrder: z.number().int().min(0).max(1000) };
export const createPackBody = z.strictObject({ ...fields, unitsPerPack: units.min(2), isActive: z.boolean().default(true), displayOrder: z.number().int().min(0).max(1000).default(0) }).refine(b => b.sellingPricePaise <= b.mrpPaise, { path:['sellingPricePaise'],message:'Selling price cannot exceed MRP' });
export const updatePackBody = z.strictObject(fields).partial().refine(b => Object.keys(b).length > 0, 'Send a field to update');
export async function validateComponents(tx: TransactionClient, components: {productId:string;quantity:number}[], comboId?: string) {
  for (const id of components.map(c => c.productId).sort()) await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "id" = ${id} FOR UPDATE`;
  const products = await tx.product.findMany({ where:{ id:{in:components.map(c => c.productId)} } });
  if (products.length !== components.length || products.some(p => p.kind !== 'STANDARD' || p.id === comboId)) throw conflict('INVALID_COMBO', 'Choose at least two different ordinary products. Combos cannot contain combos.');
}
export async function createPack(productId:string, input:z.infer<typeof createPackBody>) {
  try { return await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "id" = ${productId} FOR UPDATE`;
    const product = await tx.product.findUnique({ where:{id:productId} });
    if (!product) throw notFound('PRODUCT_NOT_FOUND','Product not found.');
    if (product.kind !== 'STANDARD') throw conflict('INVALID_PACK','Quantity packs apply to ordinary products only.');
    return tx.packVariant.create({data:{...input,productId}});
  }); } catch(error) { duplicate(error); }
}
export async function updatePack(productId:string,id:string,input:z.infer<typeof updatePackBody>) {
  try { return await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "id" = ${productId} FOR UPDATE`;
    const existing=await tx.packVariant.findFirst({where:{id,productId}});
    if(!existing) throw notFound('PACK_NOT_FOUND','This pack does not belong to the product.');
    if((input.sellingPricePaise ?? existing.sellingPricePaise) > (input.mrpPaise ?? existing.mrpPaise)) throw conflict('INVALID_PRICE','Selling price cannot exceed MRP.');
    return tx.packVariant.update({where:{id},data:input});
  }); } catch(error) { duplicate(error); }
}
function duplicate(error:unknown):never {
  if(error && typeof error==='object' && 'code' in error && error.code==='P2002') throw conflict('DUPLICATE_PACK','This pack size or pack SKU already exists. Edit the existing pack instead.');
  throw error;
}
