import type { Prisma } from '../../generated/prisma/client.js';
import { notFound } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import type { ListProductsQuery } from './catalog.schemas.js';

/** Only what customers may see: nothing inactive, and no internal stock bookkeeping. */
const publicProductInclude = {
  category: { select: { id: true, name: true, slug: true } },
  images: { orderBy: { displayOrder: 'asc' }, select: { url: true, altText: true, mediaType: true } },
} satisfies Prisma.ProductInclude;

type ProductWithRelations = Prisma.ProductGetPayload<{ include: typeof publicProductInclude }>;

function toPublicProduct(product: ProductWithRelations) {
  // Never negative: the database CHECK constraint keeps reservedQuantity <= stockQuantity.
  const availableQuantity = product.stockQuantity - product.reservedQuantity;

  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    description: product.description,
    sku: product.sku,
    mrpPaise: product.mrpPaise,
    sellingPricePaise: product.sellingPricePaise,
    isFeatured: product.isFeatured,
    isNew: product.isNew,
    availableQuantity,
    inStock: availableQuantity > 0,
    category: product.category,
    images: product.images,
  };
}

const ORDER_BY: Record<ListProductsQuery['sort'], Prisma.ProductOrderByWithRelationInput[]> = {
  newest: [{ createdAt: 'desc' }, { id: 'asc' }],
  price_asc: [{ sellingPricePaise: 'asc' }, { id: 'asc' }],
  price_desc: [{ sellingPricePaise: 'desc' }, { id: 'asc' }],
  name_asc: [{ name: 'asc' }, { id: 'asc' }],
};

const activeProductWhere = {
  isActive: true,
  category: { isActive: true },
} satisfies Prisma.ProductWhereInput;

export async function listCategories() {
  return prisma.category.findMany({
    where: { isActive: true },
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      imageUrl: true,
      displayOrder: true,
    },
  });
}

export async function listProducts(query: ListProductsQuery) {
  const where: Prisma.ProductWhereInput = {
    ...activeProductWhere,
    ...(query.category ? { category: { isActive: true, slug: query.category } } : {}),
    ...(query.ids ? { id: { in: query.ids } } : {}),
    ...(query.minPrice === undefined && query.maxPrice === undefined
      ? {}
      : {
          sellingPricePaise: {
            ...(query.minPrice === undefined ? {} : { gte: query.minPrice }),
            ...(query.maxPrice === undefined ? {} : { lte: query.maxPrice }),
          },
        }),
    // Available = on hand minus reserved by open orders, compared column to column in the database.
    ...(query.inStock ? { stockQuantity: { gt: prisma.product.fields.reservedQuantity } } : {}),
    ...(query.featured === undefined ? {} : { isFeatured: query.featured }),
    ...(query.new === undefined ? {} : { isNew: query.new }),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' } },
            { description: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [total, products] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      include: publicProductInclude,
      // Every order ends with `id`, so ties never make pages overlap or skip rows.
      orderBy: ORDER_BY[query.sort],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
  ]);

  return {
    items: products.map(toPublicProduct),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
}

/** `identifier` is the product slug (preferred, stable in links) or its id. */
export async function getProduct(identifier: string) {
  const product = await prisma.product.findFirst({
    where: { ...activeProductWhere, OR: [{ slug: identifier }, { id: identifier }] },
    include: publicProductInclude,
  });

  if (!product) {
    throw notFound('PRODUCT_NOT_FOUND', 'This product does not exist or is no longer available.');
  }
  return toPublicProduct(product);
}

export async function listDeliveryAreas() {
  return prisma.deliveryArea.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      pincode: true,
      deliveryChargePaise: true,
      minimumOrderPaise: true,
      freeDeliveryThresholdPaise: true,
    },
  });
}
