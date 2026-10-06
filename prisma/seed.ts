/**
 * Development seed. Mirrors the mock data in the mobile app (App/BuyNest/src/data) so the
 * two stay comparable until the app switches to this API.
 *
 * Everything here is PLACEHOLDER data: the delivery areas, charges, minimum orders, prices
 * and stock levels are made up for development and are not real business values.
 *
 * Safe to run repeatedly: rows are matched by slug / SKU / name. Re-running refreshes the
 * descriptive fields and prices but never touches stock, so it will not undo reservations.
 */

import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../src/generated/prisma/client.js';

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set');
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

const categories = [
  { slug: 'stationery', name: 'Stationery', description: 'Notebooks, pens and school supplies' },
  { slug: 'gift-items', name: 'Gift Items', description: 'Mugs, frames and gift boxes' },
  { slug: 'toys', name: 'Toys', description: 'Fun picks for every age' },
  { slug: 'sports-items', name: 'Sports Items', description: 'Cricket, football and more' },
  { slug: 'decoration-items', name: 'Decoration Items', description: 'Lights and party decor' },
];

type SeedProduct = {
  sku: string;
  name: string;
  slug: string;
  description: string;
  category: string;
  mrpPaise: number;
  sellingPricePaise: number;
  stockQuantity: number;
  isFeatured?: boolean;
  isNew?: boolean;
};

const products: SeedProduct[] = [
  {
    sku: 'BN-STA-001',
    name: 'Classmate Notebook (Pack of 6)',
    slug: 'classmate-notebook-pack-of-6',
    description:
      'Single-line long notebooks with 172 pages each. Smooth paper that works well with gel and ball pens.',
    category: 'stationery',
    mrpPaise: 39000,
    sellingPricePaise: 34900,
    stockQuantity: 40,
    isFeatured: true,
  },
  {
    sku: 'BN-STA-002',
    name: 'Apsara Platinum Pencil Pack',
    slug: 'apsara-platinum-pencil-pack',
    description: 'Pack of 10 extra-dark pencils with a free sharpener and eraser.',
    category: 'stationery',
    mrpPaise: 6000,
    sellingPricePaise: 5500,
    stockQuantity: 120,
  },
  {
    sku: 'BN-STA-003',
    name: 'Camlin Geometry Box',
    slug: 'camlin-geometry-box',
    description:
      'Complete geometry set with compass, divider, protractor, set squares and a 15 cm scale in a metal box.',
    category: 'stationery',
    mrpPaise: 19900,
    sellingPricePaise: 14900,
    stockQuantity: 25,
    isFeatured: true,
    isNew: true,
  },
  {
    sku: 'BN-GFT-001',
    name: 'Printed Coffee Mug',
    slug: 'printed-coffee-mug',
    description: 'Ceramic 330 ml mug with a glossy printed design. Microwave safe.',
    category: 'gift-items',
    mrpPaise: 29900,
    sellingPricePaise: 19900,
    stockQuantity: 18,
    isFeatured: true,
  },
  {
    sku: 'BN-GFT-002',
    name: 'Wooden Photo Frame',
    slug: 'wooden-photo-frame',
    description: 'Table-top wooden frame for a 5 x 7 inch photo, with a matte finish.',
    category: 'gift-items',
    mrpPaise: 34900,
    sellingPricePaise: 24900,
    stockQuantity: 12,
    isNew: true,
  },
  {
    sku: 'BN-GFT-003',
    name: 'Surprise Gift Box',
    slug: 'surprise-gift-box',
    description: 'Ready-to-gift box with chocolates, a greeting card and a small keepsake.',
    category: 'gift-items',
    mrpPaise: 59900,
    sellingPricePaise: 49900,
    stockQuantity: 4,
    isNew: true,
  },
  {
    sku: 'BN-TOY-001',
    name: 'Remote Control Car',
    slug: 'remote-control-car',
    description:
      'Rechargeable RC car with forward, reverse and turn controls. Suitable for ages 6+.',
    category: 'toys',
    mrpPaise: 99900,
    sellingPricePaise: 69900,
    stockQuantity: 8,
    isFeatured: true,
  },
  {
    sku: 'BN-TOY-002',
    name: 'Building Blocks Set (100 pcs)',
    slug: 'building-blocks-set-100-pcs',
    description: 'Colourful interlocking blocks in a storage tub. Non-toxic plastic, ages 3+.',
    category: 'toys',
    mrpPaise: 49900,
    sellingPricePaise: 39900,
    stockQuantity: 15,
    isNew: true,
  },
  {
    sku: 'BN-TOY-003',
    name: 'Soft Teddy Bear',
    slug: 'soft-teddy-bear',
    description: 'Huggable 2 ft teddy bear with soft plush fur. A favourite for birthdays.',
    category: 'toys',
    mrpPaise: 59900,
    sellingPricePaise: 44900,
    stockQuantity: 0,
  },
  {
    sku: 'BN-SPT-001',
    name: 'Kashmir Willow Cricket Bat',
    slug: 'kashmir-willow-cricket-bat',
    description: 'Full-size Kashmir willow bat for tennis and leather ball practice.',
    category: 'sports-items',
    mrpPaise: 129900,
    sellingPricePaise: 99900,
    stockQuantity: 6,
    isFeatured: true,
  },
  {
    sku: 'BN-SPT-002',
    name: 'Football (Size 5)',
    slug: 'football-size-5',
    description: 'Machine-stitched rubber football, size 5, for ground and street play.',
    category: 'sports-items',
    mrpPaise: 59900,
    sellingPricePaise: 44900,
    stockQuantity: 14,
    isNew: true,
  },
  {
    sku: 'BN-SPT-003',
    name: 'Badminton Racket Set',
    slug: 'badminton-racket-set',
    description: 'Two rackets with three shuttlecocks and a carry cover.',
    category: 'sports-items',
    mrpPaise: 79900,
    sellingPricePaise: 59900,
    stockQuantity: 10,
  },
  {
    sku: 'BN-DEC-001',
    name: 'LED String Lights (10 m)',
    slug: 'led-string-lights-10m',
    description: 'Warm white LED string lights for festivals, balconies and room decoration.',
    category: 'decoration-items',
    mrpPaise: 29900,
    sellingPricePaise: 19900,
    stockQuantity: 30,
    isFeatured: true,
    isNew: true,
  },
  {
    sku: 'BN-DEC-002',
    name: 'Birthday Decoration Kit',
    slug: 'birthday-decoration-kit',
    description: 'Happy Birthday banner, 30 balloons, foil curtain and a balloon pump.',
    category: 'decoration-items',
    mrpPaise: 49900,
    sellingPricePaise: 34900,
    stockQuantity: 20,
    isFeatured: true,
  },
  {
    sku: 'BN-DEC-003',
    name: 'Artificial Flower Set',
    slug: 'artificial-flower-set',
    description: 'Set of 6 artificial flower bunches for vases and home decoration.',
    category: 'decoration-items',
    mrpPaise: 39900,
    sellingPricePaise: 29900,
    stockQuantity: 9,
  },
];

// Placeholder localities and charges for development only.
const deliveryAreas = [
  { name: 'Main Market', deliveryChargePaise: 2000, freeDeliveryThresholdPaise: 40000 },
  { name: 'Station Road', deliveryChargePaise: 3000, freeDeliveryThresholdPaise: 50000 },
  {
    name: 'Civil Lines',
    deliveryChargePaise: 3000,
    minimumOrderPaise: 10000,
    freeDeliveryThresholdPaise: 50000,
  },
  { name: 'Gandhi Nagar', deliveryChargePaise: 2000 },
  {
    name: 'Model Town',
    deliveryChargePaise: 4000,
    minimumOrderPaise: 20000,
    freeDeliveryThresholdPaise: 75000,
  },
  { name: 'Industrial Area', deliveryChargePaise: 5000, isActive: false },
];

async function main() {
  const categoryIds = new Map<string, string>();
  for (const [index, category] of categories.entries()) {
    const data = { ...category, displayOrder: index + 1 };
    const saved = await prisma.category.upsert({
      where: { slug: category.slug },
      update: data,
      create: data,
    });
    categoryIds.set(saved.slug, saved.id);
  }

  let createdProducts = 0;
  for (const { category, stockQuantity, ...product } of products) {
    const categoryId = categoryIds.get(category);
    if (!categoryId) {
      throw new Error(`Unknown category "${category}" for ${product.sku}`);
    }
    const details = {
      ...product,
      categoryId,
      isFeatured: product.isFeatured ?? false,
      isNew: product.isNew ?? false,
    };

    const existing = await prisma.product.findUnique({ where: { sku: product.sku } });
    if (existing) {
      await prisma.product.update({ where: { id: existing.id }, data: details });
      continue;
    }

    // Opening stock is recorded as an ADJUSTMENT so the audit trail starts complete.
    await prisma.product.create({
      data: {
        ...details,
        stockQuantity,
        ...(stockQuantity > 0
          ? {
              inventoryTransactions: {
                create: { type: 'ADJUSTMENT', quantity: stockQuantity, note: 'Opening stock (seed)' },
              },
            }
          : {}),
      },
    });
    createdProducts += 1;
  }

  for (const area of deliveryAreas) {
    const data = {
      deliveryChargePaise: area.deliveryChargePaise,
      minimumOrderPaise: area.minimumOrderPaise ?? null,
      freeDeliveryThresholdPaise: area.freeDeliveryThresholdPaise ?? null,
      isActive: area.isActive ?? true,
    };
    await prisma.deliveryArea.upsert({
      where: { name: area.name },
      update: data,
      create: { name: area.name, ...data },
    });
  }

  console.log(
    `Seeded ${categories.length} categories, ${products.length} products ` +
      `(${createdProducts} new) and ${deliveryAreas.length} delivery areas.`
  );
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
