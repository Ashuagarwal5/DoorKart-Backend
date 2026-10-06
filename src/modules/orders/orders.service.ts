import type { Prisma } from '../../generated/prisma/client.js';
import { AppError, conflict, notFound, unprocessable } from '../../lib/errors.js';
import { calculateLineTotal, calculateOrderTotals } from '../../lib/pricing.js';
import { prisma, type TransactionClient } from '../../lib/prisma.js';
import { createRequestFingerprint } from './fingerprint.js';
import { addStatusHistory, claimStatusChange, releaseReservations } from './order-lifecycle.js';
import { generateTrackingToken, issueOrderNumber, isSameToken } from './order-number.js';
import type { CreateOrderInput } from './orders.schemas.js';

const orderInclude = {
  items: { orderBy: { productName: 'asc' } },
  statusHistory: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.OrderInclude;

type OrderWithRelations = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

/** The customer-facing shape of an order. Internal ids and the tracking token stay out. */
function toPublicOrder(order: OrderWithRelations) {
  return {
    orderNumber: order.orderNumber,
    orderStatus: order.orderStatus,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    deliveryAddress: {
      addressLine1: order.addressLine1,
      addressLine2: order.addressLine2,
      landmark: order.landmark,
      area: order.area,
      city: order.city,
      pincode: order.pincode,
    },
    deliveryAreaId: order.deliveryAreaId,
    items: order.items.map((item) => ({
      productId: item.productId,
      productName: item.productName,
      sku: item.sku,
      productImage: item.productImage,
      unitPricePaise: item.unitPricePaise,
      quantity: item.quantity,
      lineTotalPaise: item.lineTotalPaise,
    })),
    subtotalPaise: order.subtotalPaise,
    deliveryChargePaise: order.deliveryChargePaise,
    discountPaise: order.discountPaise,
    grandTotalPaise: order.grandTotalPaise,
    statusHistory: order.statusHistory.map((entry) => ({
      status: entry.status,
      note: entry.note,
      createdAt: entry.createdAt,
    })),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    cancelledAt: order.cancelledAt,
  };
}

export type PublicOrder = ReturnType<typeof toPublicOrder>;

/** Returned only by order creation: the one moment the customer is given their token. */
export type PlacedOrder = PublicOrder & { trackingToken: string };

function toPlacedOrder(order: OrderWithRelations): PlacedOrder {
  return { ...toPublicOrder(order), trackingToken: order.trackingToken };
}

/**
 * Reserves stock with a single atomic statement. The WHERE clause re-checks availability
 * at the moment of the write and the UPDATE takes a row lock, so of two orders racing
 * for the last unit exactly one matches a row; the other sees zero rows and is rejected.
 * A read-then-write in application code could not guarantee that.
 *
 * Prisma's query builder cannot express "stock - reserved >= quantity", hence the raw SQL.
 */
async function tryReserveStock(
  tx: TransactionClient,
  productId: string,
  quantity: number
): Promise<boolean> {
  const updatedRows = await tx.$executeRaw`
    UPDATE "Product"
    SET "reservedQuantity" = "reservedQuantity" + ${quantity}::int, "updatedAt" = NOW()
    WHERE "id" = ${productId}
      AND "isActive" = true
      AND "stockQuantity" - "reservedQuantity" >= ${quantity}::int
  `;
  return updatedRows === 1;
}

/** Works out why a reservation matched no row, to give the customer a precise reason. */
async function reservationFailure(
  tx: TransactionClient,
  productId: string,
  requestedQuantity: number
): Promise<AppError> {
  const product = await tx.product.findUnique({
    where: { id: productId },
    select: { name: true, isActive: true, stockQuantity: true, reservedQuantity: true },
  });

  if (!product) {
    return notFound('PRODUCT_NOT_FOUND', 'A product in your cart does not exist.');
  }
  if (!product.isActive) {
    return conflict('PRODUCT_UNAVAILABLE', `${product.name} is no longer available.`, { productId });
  }

  const availableQuantity = product.stockQuantity - product.reservedQuantity;
  return conflict(
    'OUT_OF_STOCK',
    availableQuantity === 0
      ? `${product.name} is out of stock.`
      : `Only ${availableQuantity} of ${product.name} available.`,
    { productId, requestedQuantity, availableQuantity }
  );
}

/**
 * Everything that makes up placing an order, inside one database transaction. Any thrown
 * error rolls all of it back, including stock reservations and the order number, so a
 * partial order can never exist.
 */
async function placeOrder(
  tx: TransactionClient,
  input: CreateOrderInput,
  requestFingerprint: string,
  now: Date
): Promise<OrderWithRelations> {
  const area = await tx.deliveryArea.findUnique({ where: { id: input.deliveryAreaId } });
  if (!area) {
    throw notFound('DELIVERY_AREA_NOT_FOUND', 'This delivery area does not exist.');
  }
  if (!area.isActive) {
    throw conflict('DELIVERY_AREA_UNAVAILABLE', `We no longer deliver to ${area.name}.`);
  }

  // Always lock products in the same order, so two orders sharing products cannot deadlock.
  const requestedItems = [...input.items].sort((a, b) => a.productId.localeCompare(b.productId));

  for (const item of requestedItems) {
    if (!(await tryReserveStock(tx, item.productId, item.quantity))) {
      throw await reservationFailure(tx, item.productId, item.quantity);
    }
  }

  // Read after reserving: this transaction now holds each row's lock, so the name, SKU
  // and price captured here cannot change before the order is committed.
  const products = await tx.product.findMany({
    where: { id: { in: requestedItems.map((item) => item.productId) } },
    include: {
      category: { select: { isActive: true } },
      images: { where: { mediaType: 'IMAGE' }, orderBy: { displayOrder: 'asc' }, take: 1, select: { url: true } },
    },
  });
  const productsById = new Map(products.map((product) => [product.id, product]));

  const orderItems = requestedItems.map((item) => {
    const product = productsById.get(item.productId);
    if (!product) {
      throw notFound('PRODUCT_NOT_FOUND', 'A product in your cart does not exist.');
    }
    if (!product.category.isActive) {
      throw conflict('PRODUCT_UNAVAILABLE', `${product.name} is no longer available.`, {
        productId: product.id,
      });
    }
    return {
      productId: product.id,
      productName: product.name,
      sku: product.sku,
      productImage: product.images[0]?.url ?? null,
      // The price is the database's, never anything the client sent.
      unitPricePaise: product.sellingPricePaise,
      quantity: item.quantity,
      lineTotalPaise: calculateLineTotal(product.sellingPricePaise, item.quantity),
    };
  });

  const totals = calculateOrderTotals(orderItems, area);

  if (area.minimumOrderPaise !== null && totals.subtotalPaise < area.minimumOrderPaise) {
    throw unprocessable(
      'MINIMUM_ORDER_NOT_MET',
      `The minimum order for ${area.name} is not met.`,
      {
        minimumOrderPaise: area.minimumOrderPaise,
        subtotalPaise: totals.subtotalPaise,
        shortfallPaise: area.minimumOrderPaise - totals.subtotalPaise,
      }
    );
  }

  // Guest checkout: the mobile number identifies the customer, so a returning customer
  // is reused (and their name refreshed) instead of duplicated.
  const customer = await tx.customer.upsert({
    where: { mobile: input.customer.mobile },
    update: { fullName: input.customer.fullName },
    create: { fullName: input.customer.fullName, mobile: input.customer.mobile },
  });

  const order = await tx.order.create({
    data: {
      orderNumber: await issueOrderNumber(tx, now),
      clientRequestId: input.clientRequestId,
      requestFingerprint,
      trackingToken: generateTrackingToken(),
      customerId: customer.id,
      customerName: input.customer.fullName,
      customerPhone: input.customer.mobile,
      addressLine1: input.address.addressLine1,
      addressLine2: input.address.addressLine2,
      landmark: input.address.landmark,
      area: area.name,
      city: input.address.city,
      pincode: input.address.pincode,
      deliveryAreaId: area.id,
      ...totals,
      paymentMethod: input.paymentMethod,
      // COD is collected at the door, so a new order is never marked as paid.
      paymentStatus: 'PENDING',
      orderStatus: 'PLACED',
      items: { create: orderItems },
      statusHistory: { create: { status: 'PLACED' } },
    },
    include: orderInclude,
  });

  await tx.inventoryTransaction.createMany({
    data: orderItems.map((item) => ({
      productId: item.productId,
      orderId: order.id,
      type: 'RESERVE' as const,
      quantity: item.quantity,
    })),
  });

  return order;
}

function findOrderByClientRequestId(clientRequestId: string) {
  return prisma.order.findUnique({ where: { clientRequestId }, include: orderInclude });
}

/**
 * A repeated clientRequestId is only a retry if it asks for the same purchase. Anything
 * else would let one id stand for two different orders, and would hand the first order's
 * tracking token to a request that does not know what the first order was.
 *
 * A missing fingerprint (an order created before fingerprints existed) can never be
 * confirmed, so it never matches.
 */
function replayOf(existing: OrderWithRelations, fingerprint: string): PlacedOrder {
  if (existing.requestFingerprint !== fingerprint) {
    throw conflict(
      'IDEMPOTENCY_CONFLICT',
      'This request id was already used for a different order. Start a new order to continue.'
    );
  }
  return toPlacedOrder(existing);
}

/**
 * Creates an order, or returns the one already created for this `clientRequestId`.
 * `created` is false for such a replay, so a retried request (double tap, timeout, weak
 * connection) can never produce a second order. The replay must carry the same purchase
 * as the original; a different one is rejected with IDEMPOTENCY_CONFLICT.
 */
export async function createOrder(
  input: CreateOrderInput
): Promise<{ order: PlacedOrder; created: boolean }> {
  const fingerprint = createRequestFingerprint(input);

  const existing = await findOrderByClientRequestId(input.clientRequestId);
  if (existing) {
    return { order: replayOf(existing, fingerprint), created: false };
  }

  try {
    const order = await prisma.$transaction((tx) => placeOrder(tx, input, fingerprint, new Date()));
    return { order: toPlacedOrder(order), created: true };
  } catch (error) {
    // Two copies of the same request can run at once. The loser fails, either on the
    // unique clientRequestId or because the winner just reserved the stock. If it carries
    // the same purchase it answers with the winner's order; if not, it is a conflict.
    const winner = await findOrderByClientRequestId(input.clientRequestId);
    if (winner) {
      return { order: replayOf(winner, fingerprint), created: false };
    }
    throw error;
  }
}

/** Loads an order only for a caller holding its tracking token. */
async function findAuthorizedOrder(
  orderNumber: string,
  trackingToken: string
): Promise<OrderWithRelations> {
  const order = await prisma.order.findUnique({ where: { orderNumber }, include: orderInclude });
  if (!order) {
    throw notFound('ORDER_NOT_FOUND', 'This order does not exist.');
  }
  if (!isSameToken(trackingToken, order.trackingToken)) {
    throw new AppError(403, 'INVALID_TRACKING_TOKEN', 'The tracking token is not valid for this order.');
  }
  return order;
}

export async function getOrder(orderNumber: string, trackingToken: string): Promise<PublicOrder> {
  return toPublicOrder(await findAuthorizedOrder(orderNumber, trackingToken));
}

/**
 * Customer cancellation: PLACED -> CANCELLED only. The order row and its totals are kept;
 * the reserved stock is released and both movements are recorded.
 */
export async function cancelOrder(orderNumber: string, trackingToken: string): Promise<PublicOrder> {
  const order = await findAuthorizedOrder(orderNumber, trackingToken);

  const cancelled = await prisma.$transaction(async (tx) => {
    // The status check is part of the UPDATE itself, so two simultaneous cancellations
    // (or a cancel racing a confirm) cannot both succeed and release the stock twice.
    await claimStatusChange(tx, {
      orderId: order.id,
      allowedFrom: ['PLACED'],
      to: 'CANCELLED',
      extras: { cancelledAt: new Date() },
      reject: (current) =>
        conflict('ORDER_CANNOT_BE_CANCELLED', 'This order can no longer be cancelled.', {
          orderStatus: current?.orderStatus,
        }),
    });

    await releaseReservations(tx, order.id, order.items);
    await addStatusHistory(tx, order.id, 'CANCELLED', 'Cancelled by customer');

    return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
  });
  return toPublicOrder(cancelled);
}
