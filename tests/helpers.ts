import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { expect } from 'vitest';

import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword } from '../src/modules/admin/auth/password.js';

export { prisma };

/** The login rate limit is raised so the many sign-ins in these tests cannot lock each other out. */
export const app = createApp({ loginRateLimit: { limit: 10_000, windowMs: 60_000 } });

export async function resetDatabase(): Promise<void> {
  await prisma.$executeRaw`
    TRUNCATE "InventoryTransaction", "OrderStatusHistory", "PaymentStatusHistory", "OrderItem", "Order", "OrderCounter",
             "Customer", "ProductImage", "Product", "Category", "DeliveryArea", "AdminSession", "AdminUser",
             "AccountSession", "Account", "EmailOtp", "Setting"
    CASCADE
  `;
}

/** A small, known catalogue. Prices are chosen so expected totals are easy to check by hand. */
export async function seedFixtures() {
  const stationery = await prisma.category.create({
    data: { name: 'Stationery', slug: 'stationery', displayOrder: 2 },
  });
  const toys = await prisma.category.create({
    data: { name: 'Toys', slug: 'toys', displayOrder: 1 },
  });
  const hiddenCategory = await prisma.category.create({
    data: { name: 'Hidden', slug: 'hidden', displayOrder: 3, isActive: false },
  });

  const product = (
    sku: string,
    name: string,
    categoryId: string,
    sellingPricePaise: number,
    stockQuantity: number,
    extra: { isActive?: boolean; isFeatured?: boolean; isNew?: boolean } = {}
  ) =>
    prisma.product.create({
      data: {
        sku,
        name,
        slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        description: `${name} description`,
        categoryId,
        mrpPaise: sellingPricePaise + 5000,
        sellingPricePaise,
        stockQuantity,
        ...extra,
      },
    });

  const products = {
    // ₹349.00, featured
    notebook: await product('T-001', 'Classmate Notebook', stationery.id, 34900, 10, {
      isFeatured: true,
    }),
    // ₹149.50: a price with paise, to catch any floating point money maths
    pencil: await product('T-002', 'Pencil Pack', stationery.id, 14950, 100, { isNew: true }),
    lastOne: await product('T-003', 'Remote Car', toys.id, 69900, 1),
    soldOut: await product('T-004', 'Teddy Bear', toys.id, 44900, 0),
    inactive: await product('T-005', 'Retired Toy', toys.id, 9900, 5, { isActive: false }),
    inHiddenCategory: await product('T-006', 'Hidden Thing', hiddenCategory.id, 9900, 5),
  };

  await prisma.productImage.create({
    data: { productId: products.notebook.id, url: 'https://example.test/notebook.jpg' },
  });

  const areas = {
    // ₹30 delivery, free from ₹500
    standard: await prisma.deliveryArea.create({
      data: { name: 'Station Road', deliveryChargePaise: 3000, freeDeliveryThresholdPaise: 50000 },
    }),
    // ₹40 delivery, minimum order ₹200
    withMinimum: await prisma.deliveryArea.create({
      data: { name: 'Model Town', deliveryChargePaise: 4000, minimumOrderPaise: 20000 },
    }),
    inactive: await prisma.deliveryArea.create({
      data: { name: 'Industrial Area', deliveryChargePaise: 5000, isActive: false },
    }),
  };

  return { categories: { stationery, toys, hiddenCategory }, products, areas };
}

export type Fixtures = Awaited<ReturnType<typeof seedFixtures>>;

type OrderPayloadOptions = {
  deliveryAreaId: string;
  items: { productId: string; quantity: number }[];
  clientRequestId?: string;
  mobile?: string;
};

export function orderPayload(options: OrderPayloadOptions) {
  return {
    clientRequestId: options.clientRequestId ?? randomUUID(),
    customer: { fullName: 'Ravi Kumar', mobile: options.mobile ?? '9876543210' },
    address: {
      addressLine1: '12 Shastri Street',
      addressLine2: '',
      landmark: 'Near the temple',
      city: 'Testpur',
      pincode: '226001',
    },
    deliveryAreaId: options.deliveryAreaId,
    items: options.items,
    paymentMethod: 'COD',
  };
}

export async function getStock(productId: string) {
  return prisma.product.findUniqueOrThrow({
    where: { id: productId },
    select: { stockQuantity: true, reservedQuantity: true },
  });
}

/** Not a real credential: it exists only inside the throwaway test database. */
export const TEST_PASSWORD = 'test-only-password-1';
export const TEST_ADMIN_EMAIL = 'admin@example.test';

export async function createTestAdmin(
  overrides: { email?: string; name?: string; isActive?: boolean; role?: 'ADMIN' | 'SUPER_ADMIN' } = {}
) {
  return prisma.adminUser.create({
    data: {
      name: 'Test Admin',
      email: TEST_ADMIN_EMAIL,
      // Cheap scrypt settings keep the suite fast; verification reads them from the hash.
      passwordHash: await hashPassword(TEST_PASSWORD, { N: 2 ** 12, r: 8, p: 1 }),
      ...overrides,
    },
  });
}

/** A supertest agent that has signed in and carries the admin session cookie. */
export async function signIn(email: string = TEST_ADMIN_EMAIL) {
  const agent = request.agent(app);
  const response = await agent
    .post('/api/v1/admin/auth/login')
    .send({ email, password: TEST_PASSWORD });
  expect(response.status).toBe(200);
  return agent;
}

export type AdminAgent = Awaited<ReturnType<typeof signIn>>;

/** Places an order through the public API, as the mobile app would. */
export async function placeTestOrder(
  fixtures: Fixtures,
  items: { productId: string; quantity: number }[],
  options: { deliveryAreaId?: string; mobile?: string } = {}
) {
  const response = await request(app)
    .post('/api/v1/orders')
    .send(
      orderPayload({
        deliveryAreaId: options.deliveryAreaId ?? fixtures.areas.standard.id,
        items,
        mobile: options.mobile,
      })
    );
  expect(response.status).toBe(201);
  const order = await prisma.order.findUniqueOrThrow({
    where: { orderNumber: response.body.data.orderNumber },
  });
  return { ...response.body.data, id: order.id } as { id: string; orderNumber: string; trackingToken: string; grandTotalPaise: number };
}

/** Moves an order through admin statuses in order, failing the test if any step is refused. */
export async function advance(agent: AdminAgent, orderId: string, statuses: string[]) {
  for (const status of statuses) {
    const response = await agent.patch(`/api/v1/admin/orders/${orderId}/status`).send({ status });
    expect(response.status, `moving to ${status}`).toBe(200);
  }
}
