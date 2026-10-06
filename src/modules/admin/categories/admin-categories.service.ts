import type { Prisma } from '../../../generated/prisma/client.js';
import { AppError, conflict, notFound } from '../../../lib/errors.js';
import { isUniqueViolation } from '../../../lib/prisma-errors.js';
import { prisma } from '../../../lib/prisma.js';
import { slugify } from '../../../lib/slug.js';
import type { CreateCategoryBody, UpdateCategoryBody } from './admin-categories.schemas.js';

const categoryArgs = {
  include: { _count: { select: { products: true } } },
} satisfies Prisma.CategoryDefaultArgs;

type CategoryWithCount = Prisma.CategoryGetPayload<typeof categoryArgs>;

function toAdminCategory(category: CategoryWithCount) {
  return {
    id: category.id,
    name: category.name,
    slug: category.slug,
    description: category.description,
    imageUrl: category.imageUrl,
    displayOrder: category.displayOrder,
    isActive: category.isActive,
    productCount: category._count.products,
    createdAt: category.createdAt,
    updatedAt: category.updatedAt,
  };
}

async function assertSlugFree(slug: string, exceptId?: string) {
  const taken = await prisma.category.findFirst({
    where: { slug, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (taken) {
    throw conflict('DUPLICATE_SLUG', `The slug "${slug}" is already used by another category.`);
  }
}

/** All categories, inactive ones included, in the order the shop shows them. */
export async function listCategories() {
  const categories = await prisma.category.findMany({
    ...categoryArgs,
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
  });
  return categories.map(toAdminCategory);
}

export async function createCategory(body: CreateCategoryBody) {
  const slug = body.slug ?? slugify(body.name);
  if (slug === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Give the category a slug: the name has no letters or digits to build one from.');
  }
  await assertSlugFree(slug);

  try {
    const created = await prisma.category.create({
      data: {
        name: body.name,
        slug,
        description: body.description,
        imageUrl: body.imageUrl,
        displayOrder: body.displayOrder,
        isActive: body.isActive,
      },
      ...categoryArgs,
    });
    return toAdminCategory(created);
  } catch (error) {
    if (isUniqueViolation(error, 'slug')) {
      throw conflict('DUPLICATE_SLUG', 'That slug is already used by another category.');
    }
    throw error;
  }
}

/**
 * Categories are never deleted (products belong to them): set `isActive` to false to hide
 * one. The shop then stops listing it and its products, but nothing is lost.
 */
export async function updateCategory(id: string, body: UpdateCategoryBody) {
  const existing = await prisma.category.findUnique({ where: { id }, select: { slug: true } });
  if (!existing) {
    throw notFound('CATEGORY_NOT_FOUND', 'This category does not exist.');
  }
  if (body.slug !== undefined && body.slug !== existing.slug) {
    await assertSlugFree(body.slug, id);
  }

  try {
    const updated = await prisma.category.update({ where: { id }, data: body, ...categoryArgs });
    return toAdminCategory(updated);
  } catch (error) {
    if (isUniqueViolation(error, 'slug')) {
      throw conflict('DUPLICATE_SLUG', 'That slug is already used by another category.');
    }
    throw error;
  }
}
