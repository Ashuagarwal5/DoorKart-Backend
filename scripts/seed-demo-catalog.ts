/**
 * Adds demo products (with generated placeholder pictures) to the database in DATABASE_URL.
 *
 *   npm run seed:demo
 *
 * Safe to run twice: a product whose SKU already exists is skipped. Products are created through
 * the same service the admin panel uses, so prices, stock history and pictures follow the real
 * rules. Nothing is deleted or changed. Everything it makes can be edited in the admin panel.
 */
import { env } from '../src/config/env.js';
import { prisma } from '../src/lib/prisma.js';
import { createProduct } from '../src/modules/admin/products/admin-products.service.js';
import { slugify } from '../src/lib/slug.js';
import { saveMedia } from '../src/modules/media/media-storage.js';
import { DEMO_PRODUCTS } from './demo-catalog-data.js';
import { makeDemoPicture } from './demo-pictures.js';

const toPaise = (rupees: number) => Math.round(rupees * 100);

async function main() {
  const admin = await prisma.adminUser.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
  if (!admin) {
    throw new Error('Create an admin first (npm run admin:create): stock changes are recorded against an admin.');
  }

  const categories = await prisma.category.findMany({ select: { id: true, slug: true } });
  const categoryBySlug = new Map(categories.map((category) => [category.slug, category.id]));

  console.log(`Adding demo products to ${new URL(env.databaseUrl).host} (pictures go to ${env.uploadDir})`);

  let created = 0;
  let skipped = 0;
  for (const demo of DEMO_PRODUCTS) {
    const sku = `DK-${demo.code}`;
    if (await prisma.product.findUnique({ where: { sku }, select: { id: true } })) {
      skipped += 1;
      continue;
    }
    const categoryId = categoryBySlug.get(demo.category);
    if (!categoryId) {
      throw new Error(`There is no category with the slug "${demo.category}". Create it in the admin panel first.`);
    }

    // A name like an existing product's would give the same web address, so the code is added to it.
    const baseSlug = slugify(demo.name);
    const slug = (await prisma.product.findUnique({ where: { slug: baseSlug }, select: { id: true } }))
      ? `${baseSlug}-${demo.code.toLowerCase()}`
      : baseSlug;

    const images = [];
    for (let index = 0; index < (demo.pictures ?? 1); index += 1) {
      const url = await saveMedia(await makeDemoPicture(demo.category, demo.name, index), {
        kind: 'IMAGE',
        extension: 'jpg',
      });
      images.push({ url, mediaType: 'IMAGE' as const, altText: demo.name });
    }

    await createProduct(
      {
        name: demo.name,
        slug,
        description: demo.description,
        categoryId,
        sku,
        mrpPaise: toPaise(demo.mrp),
        sellingPricePaise: toPaise(demo.price),
        stockQuantity: demo.stock,
        lowStockThreshold: 5,
        isFeatured: demo.featured ?? false,
        isNew: demo.isNew ?? false,
        isActive: true,
        images,
      },
      { id: admin.id, name: admin.name, email: admin.email, role: admin.role, sessionId: 'demo-seed' }
    );
    created += 1;
    console.log(`  + ${sku}  ${demo.name}`);
  }

  console.log(`Done: ${created} added, ${skipped} already there.`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
