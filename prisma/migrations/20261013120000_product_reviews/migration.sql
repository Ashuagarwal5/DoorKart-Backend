-- Additive: no order, item, account, stock or purchase-history records are changed.
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'PUBLISHED', 'REJECTED', 'HIDDEN');
CREATE TYPE "ReviewOrigin" AS ENUM ('CUSTOMER', 'ADMIN_ENTERED', 'IMPORTED');
CREATE TABLE "Review" (
  "id" TEXT NOT NULL, "productId" TEXT NOT NULL, "accountId" TEXT, "purchaseItemId" TEXT,
  "rating" INTEGER NOT NULL, "title" TEXT NOT NULL, "content" TEXT NOT NULL,
  "reviewerName" TEXT NOT NULL, "origin" "ReviewOrigin" NOT NULL DEFAULT 'CUSTOMER',
  "sourceLabel" TEXT, "status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
  "createdByAdminId" TEXT, "moderatedByAdminId" TEXT, "moderationNote" TEXT,
  "moderatedAt" TIMESTAMP(3), "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Review_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Review_rating_check" CHECK ("rating" BETWEEN 1 AND 5),
  CONSTRAINT "Review_text_check" CHECK (length(trim("title")) BETWEEN 1 AND 120 AND length(trim("content")) BETWEEN 1 AND 10000),
  CONSTRAINT "Review_origin_check" CHECK (
    ("origin" = 'CUSTOMER' AND "accountId" IS NOT NULL AND "createdByAdminId" IS NULL AND "sourceLabel" IS NULL)
    OR ("origin" IN ('ADMIN_ENTERED', 'IMPORTED') AND "accountId" IS NULL AND "purchaseItemId" IS NULL AND "createdByAdminId" IS NOT NULL AND "sourceLabel" IS NOT NULL AND length(trim("sourceLabel")) > 0)
  )
);
CREATE UNIQUE INDEX "Review_productId_accountId_key" ON "Review"("productId", "accountId");
CREATE INDEX "Review_productId_status_deletedAt_createdAt_id_idx" ON "Review"("productId", "status", "deletedAt", "createdAt", "id");
CREATE INDEX "Review_accountId_createdAt_id_idx" ON "Review"("accountId", "createdAt", "id");
CREATE INDEX "Review_status_createdAt_id_idx" ON "Review"("status", "createdAt", "id");
CREATE INDEX "Review_purchaseItemId_idx" ON "Review"("purchaseItemId");
ALTER TABLE "Review" ADD CONSTRAINT "Review_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Review" ADD CONSTRAINT "Review_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Review" ADD CONSTRAINT "Review_purchaseItemId_fkey" FOREIGN KEY ("purchaseItemId") REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
