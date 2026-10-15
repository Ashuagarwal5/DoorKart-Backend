import { ApiError, toApiErrorCode } from '../../App/BuyNest/src/services/api/api-error.js';
import { keepPendingOrder } from '../../App/BuyNest/src/features/orders/pending-order-access.js';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { advance, app, createTestAdmin, createTestBuyer, getStock, orderPayload, prisma, resetDatabase, seedFixtures, signIn, type AdminAgent, type Fixtures } from './helpers.js';
import { cartReducer, initialCartState } from '../../App/BuyNest/src/features/cart/cart-reducer.js';
import { cartProductKey, selectProductPack } from '../../App/BuyNest/src/features/cart/product-pack.js';
import { fingerprintCartItems } from '../../App/BuyNest/src/features/cart/cart-fingerprint.js';
import type { Product } from '../../App/BuyNest/src/types/catalog.js';

let fixtures:Fixtures;let admin:AdminAgent;let buyer:Awaited<ReturnType<typeof createTestBuyer>>;
const products='/api/v1/admin/products';
beforeEach(async()=>{await resetDatabase();fixtures=await seedFixtures();await createTestAdmin();admin=await signIn();buyer=await createTestBuyer();});
async function pack(productId=fixtures.products.notebook.id,units=3){const r=await admin.post(`${products}/${productId}/packs`).send({label:`Pack of ${units}`,sku:`PACK-${units}`,unitsPerPack:units,mrpPaise:15000,sellingPricePaise:12000});expect(r.status).toBe(201);return r.body.data as {id:string};}
async function combo(){const r=await admin.post(products).send({kind:'COMBO',name:'School combo',description:'Notebook and toy combo',sku:'SCHOOL-COMBO',categoryId:fixtures.categories.stationery.id,mrpPaise:40000,sellingPricePaise:25000,comboComponents:[{productId:fixtures.products.notebook.id,quantity:2},{productId:fixtures.products.pencil.id,quantity:1}]});expect(r.status).toBe(201);return r.body.data as {id:string};}
async function submit(items:{productId:string;variantId?:string;quantity:number}[],extra:object={}){return request(app).post('/api/v1/orders').auth(buyer.token,{type:'bearer'}).send({...orderPayload({deliveryAreaId:fixtures.areas.standard.id,items}),...extra});}
async function orderId(number:string){return (await prisma.order.findUniqueOrThrow({where:{orderNumber:number}})).id;}
const action=(id:string,input:object)=>admin.post(`/api/v1/admin/returns/${id}/actions`).send({requestId:randomUUID(),note:'Inspected physical goods in store',...input});

describe('product quantity packs and combo orders',()=>{
  it('protects admin editing and validates duplicate sizes, prices, nested combos and immutable product type',async()=>{
    const id=fixtures.products.notebook.id;
    expect((await request(app).post(`${products}/${id}/packs`).send({})).status).toBe(401);
    const p=await pack();
    expect((await admin.post(`${products}/${id}/packs`).send({label:'Duplicate',sku:'OTHER',unitsPerPack:3,mrpPaise:15000,sellingPricePaise:12000})).status).toBe(409);
    expect((await admin.patch(`${products}/${id}/packs/${p.id}`).send({sellingPricePaise:16000})).status).toBe(409);
    expect((await admin.patch(`${products}/${id}/packs/${p.id}`).send({unitsPerPack:4})).status).toBe(400);
    expect((await admin.patch(`${products}/${fixtures.products.pencil.id}/packs/${p.id}`).send({isActive:false})).status).toBe(404);
    const c=await combo();
    expect((await admin.patch(`${products}/${c.id}`).send({kind:'STANDARD'})).status).toBe(400);
    expect((await admin.patch(`${products}/${c.id}`).send({comboComponents:[{productId:c.id,quantity:1},{productId:id,quantity:1}]})).status).toBe(409);
    expect((await admin.post(`${products}/${c.id}/inventory-adjustment`).send({quantityDelta:1,note:'Added stock'})).body.error.code).toBe('COMBO_STOCK_MANAGED');
  });
  it('keeps separate pack lines and aggregates overlapping physical reservations with server prices',async()=>{
    const p=await pack();const c=await combo();const base=fixtures.products.notebook;
    const r=await submit([{productId:base.id,quantity:1},{productId:base.id,variantId:p.id,quantity:2},{productId:c.id,quantity:1}]);
    expect(r.status).toBe(201);expect(r.body.data.items).toHaveLength(3);
    expect(r.body.data.subtotalPaise).toBe(base.sellingPricePaise+24000+25000);
    expect((await getStock(base.id)).reservedQuantity).toBe(9);
    expect((await getStock(fixtures.products.pencil.id)).reservedQuantity).toBe(1);
    const movements=await prisma.inventoryTransaction.findMany({where:{orderId:await orderId(r.body.data.orderNumber),type:'RESERVE'}});
    expect(movements).toHaveLength(2);expect(movements.find(m=>m.productId===base.id)?.quantity).toBe(9);
  });
  it('rejects overdrawn shared stock atomically without creating orders or audit reservations',async()=>{
    const p=await pack();const id=fixtures.products.notebook.id;await prisma.product.update({where:{id},data:{stockQuantity:4}});
    const r=await submit([{productId:id,quantity:2},{productId:id,variantId:p.id,quantity:1}]);expect(r.status).toBe(409);
    expect(await prisma.order.count()).toBe(0);expect(await getStock(id)).toEqual({stockQuantity:4,reservedQuantity:0});expect(await prisma.inventoryTransaction.count()).toBe(0);
  });
  it('prevents concurrent packs and singles from overselling shared stock',async()=>{
    const p=await pack();const id=fixtures.products.notebook.id;await prisma.product.update({where:{id},data:{stockQuantity:3}});
    const results=await Promise.all([submit([{productId:id,variantId:p.id,quantity:1}]),submit([{productId:id,quantity:3}])]);
    expect(results.map(r=>r.status).sort()).toEqual([201,409]);expect((await getStock(id)).reservedQuantity).toBe(3);
  });
  it('preserves snapshots through pack and combo edits and deducts original physical quantities on delivery',async()=>{
    const p=await pack();const c=await combo();const base=fixtures.products.notebook;
    const r=await submit([{productId:base.id,variantId:p.id,quantity:1},{productId:c.id,quantity:1}]);expect(r.status).toBe(201);const id=await orderId(r.body.data.orderNumber);
    expect((await admin.patch(`${products}/${base.id}/packs/${p.id}`).send({label:'Renamed pack',sellingPricePaise:10000})).status).toBe(200);
    expect((await admin.patch(`${products}/${c.id}`).send({comboComponents:[{productId:base.id,quantity:1},{productId:fixtures.products.pencil.id,quantity:2}]})).status).toBe(200);
    await advance(admin,id,['CONFIRMED','PACKED','OUT_FOR_DELIVERY','DELIVERED']);
    expect(await getStock(base.id)).toEqual({stockQuantity:base.stockQuantity-5,reservedQuantity:0});
    expect((await getStock(fixtures.products.pencil.id)).stockQuantity).toBe(fixtures.products.pencil.stockQuantity-1);
    const view=(await admin.get(`/api/v1/admin/orders/${id}`)).body.data;
    expect(view.items.find((i:{variantId:string})=>i.variantId===p.id)).toMatchObject({packLabel:'Pack of 3',unitPricePaise:12000});
    expect(view.items.find((i:{productId:string})=>i.productId===c.id).components.find((i:{productId:string})=>i.productId===base.id).unitsPerPack).toBe(2);
  });
  it('cancels component reservations once and rejects forged or inactive pack references',async()=>{
    const p=await pack();const c=await combo();const id=fixtures.products.notebook.id;
    expect((await submit([{productId:fixtures.products.pencil.id,variantId:p.id,quantity:1}])).status).toBe(409);
    const r=await submit([{productId:id,variantId:p.id,quantity:1},{productId:c.id,quantity:1}]);expect(r.status).toBe(201);
    await advance(admin,await orderId(r.body.data.orderNumber),['CANCELLED']);expect((await getStock(id)).reservedQuantity).toBe(0);
    await admin.patch(`${products}/${id}/packs/${p.id}`).send({isActive:false});expect((await submit([{productId:id,variantId:p.id,quantity:1}])).status).toBe(409);
  });
  it('returns the same pack purchase on retries and rejects changed pack identity',async()=>{
    const p=await pack();const clientRequestId=randomUUID();const items=[{productId:fixtures.products.notebook.id,variantId:p.id,quantity:1}];
    const first=await submit(items,{clientRequestId});expect(first.status).toBe(201);const second=await submit(items,{clientRequestId});expect(second.status).toBe(200);expect(second.body.data.orderNumber).toBe(first.body.data.orderNumber);
    expect((await submit([{productId:fixtures.products.notebook.id,quantity:1}],{clientRequestId})).body.error.code).toBe('IDEMPOTENCY_CONFLICT');expect(await prisma.order.count()).toBe(1);
  });
  it('calculates combo availability and hides inactive packs without treating combos as physical low stock',async()=>{
    const c=await combo();const p=await pack();const base=fixtures.products.notebook;
    await prisma.product.update({where:{id:base.id},data:{stockQuantity:5}});
    const view=await request(app).get(`/api/v1/products/${c.id}`);expect(view.body.data.availableQuantity).toBe(Math.min(2,fixtures.products.pencil.stockQuantity));
    await admin.patch(`${products}/${base.id}/packs/${p.id}`).send({isActive:false});expect((await request(app).get(`/api/v1/products/${base.id}`)).body.data.variants).toEqual([]);
    await prisma.product.update({where:{id:fixtures.products.pencil.id},data:{isActive:false}});
    expect((await request(app).get(`/api/v1/products/${c.id}`)).body.data.availableQuantity).toBe(0);
    expect((await request(app).get(`/api/v1/products?inStock=true&ids=${c.id}`)).body.data.items).toEqual([]);
    expect((await admin.get(`${products}?kind=STANDARD`)).body.data.items.some((p:{id:string})=>p.id===c.id)).toBe(false);
  });
  it('verifies pack purchases for the parent product and combo purchases for the combo only',async()=>{
    const p=await pack();const c=await combo();const base=fixtures.products.notebook.id;
    const r=await submit([{productId:base,variantId:p.id,quantity:1},{productId:c.id,quantity:1}]);await advance(admin,await orderId(r.body.data.orderNumber),['CONFIRMED','PACKED','OUT_FOR_DELIVERY','DELIVERED']);
    for(const id of [base,c.id]){const review=await request(app).post(`/api/v1/account/reviews/product/${id}`).auth(buyer.token,{type:'bearer'}).send({rating:5,title:'Good product',content:'Delivered in good condition.'});expect(review.status).toBe(201);expect(review.body.data.verifiedPurchase).toBe(true);}
    expect((await request(app).post(`/api/v1/account/reviews/product/${fixtures.products.pencil.id}`).auth(buyer.token,{type:'bearer'}).send({rating:5,title:'Good product',content:'Delivered in good condition.'})).status).toBe(403);
  });
  it('inspects and restocks only eligible physical components of complete returned packs once',async()=>{
    const c=await combo();const base=fixtures.products.notebook;
    const r=await submit([{productId:c.id,quantity:1}]);const id=await orderId(r.body.data.orderNumber);await advance(admin,id,['CONFIRMED','PACKED','OUT_FOR_DELIVERY','DELIVERED']);
    const item=await prisma.orderItem.findFirstOrThrow({where:{orderId:id}});
    const result=await admin.post('/api/v1/admin/returns').send({clientRequestId:randomUUID(),orderId:id,kind:'RETURN_ONLY',reason:'Returned complete combo with damage',requestedAmountPaise:0,items:[{orderItemId:item.id,quantity:1}]});expect(result.status).toBe(201);
    const caseId=result.body.data.id;expect((await action(caseId,{action:'APPROVE',approvedAmountPaise:0})).status).toBe(200);
    const line=result.body.data.items[0];expect((await action(caseId,{action:'RECEIVE',items:[{itemId:line.id,receivedQuantity:1,sellableQuantity:1,conditionNote:'All okay'}]})).status).toBe(409);
    const components=line.components.map((c:{id:string;productId:string;quantity:number})=>({componentId:c.id,sellableQuantity:c.productId===base.id?1:0,conditionNote:'One sellable; other units damaged'}));
    expect((await action(caseId,{action:'RECEIVE',items:[{itemId:line.id,receivedQuantity:1,sellableQuantity:0,conditionNote:'Inspected all combo contents',components}]})).status).toBe(200);
    expect((await getStock(base.id)).stockQuantity).toBe(base.stockQuantity-2);
    expect((await action(caseId,{action:'RESTOCK',itemId:line.id})).status).toBe(200);expect((await getStock(base.id)).stockQuantity).toBe(base.stockQuantity-1);
    expect((await action(caseId,{action:'RESTOCK',itemId:line.id})).status).toBe(409);expect((await getStock(c.id)).stockQuantity).toBe(0);
  });
});

describe('mobile pack cart compatibility',()=>{
  const product:Product={id:'boxes',name:'Pencil box',slug:'boxes',description:'',categoryId:'s',categorySlug:'s',categoryName:'Stationery',images:[],mrp:5000,sellingPrice:5000,stockQuantity:10,isNew:false,isFeatured:false,variants:[{id:'three',label:'3 boxes',unitsPerPack:3,mrp:15000,sellingPrice:12000,availableQuantity:3}]};
  it('preserves legacy carts and keeps packs as separate lines through storage, edits and refresh',()=>{
    let state=cartReducer(initialCartState,{type:'add',product,quantity:1});state=cartReducer(state,{type:'add',product:selectProductPack(product,'three'),quantity:2});expect(state.entries).toHaveLength(2);
    expect(cartReducer(initialCartState,{type:'hydrate',entries:JSON.parse(JSON.stringify(state.entries))})).toEqual(state);
    const refreshed=cartReducer(state,{type:'sync',products:[{...product,variants:product.variants!.map(v=>({...v,sellingPrice:11000}))}],unavailableIds:[]});expect(refreshed.entries[1]?.product.sellingPrice).toBe(11000);expect(refreshed.entries[1]?.quantity).toBe(2);
    const removed=cartReducer(state,{type:'remove',productId:cartProductKey(state.entries[1]!.product)});expect(removed.entries).toHaveLength(1);expect(removed.entries[0]?.product.variantId).toBeUndefined();
    expect(fingerprintCartItems([{productId:'boxes',quantity:1}])).toBe('boxesx1');expect(fingerprintCartItems([{productId:'boxes',variantId:'three',quantity:1}])).not.toBe('boxesx1');
  });
  it('limits additions against stock shared by single units and packs',()=>{
    let state=cartReducer(initialCartState,{type:'add',product,quantity:2});state=cartReducer(state,{type:'add',product:selectProductPack(product,'three'),quantity:3});expect(state.entries[1]?.quantity).toBe(2);
    expect(cartReducer(state,{type:'add',product,quantity:100}).entries[0]?.quantity).toBe(4);
    const unavailable=cartReducer(state,{type:'sync',products:[{...product,variants:[]}],unavailableIds:[]});expect(unavailable.entries[1]?.product.stockQuantity).toBe(0);expect(unavailable.entries[1]?.quantity).toBe(2);
  });
});

describe('pack checkout failure handling',()=>{
  it.each(['CATALOG_CHANGED','QUANTITY_LIMIT'])('recognizes %s as a definite refusal while preserving timeouts',code=>{
    const error=new ApiError(toApiErrorCode(code),{status:409});
    expect(error.code).toBe(code);
    expect(error.message).not.toContain('Something went wrong');
    expect(keepPendingOrder(error,true,'buyer')).toBe(false);
    expect(keepPendingOrder(new ApiError('TIMEOUT'),true,'buyer')).toBe(true);
  });
});
