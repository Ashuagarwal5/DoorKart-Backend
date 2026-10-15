
-- Existing products and orders retain their prices, stock and fulfillment history.
CREATE TYPE "ProductKind" AS ENUM ('STANDARD','COMBO');
ALTER TABLE "Product" ADD COLUMN "kind" "ProductKind" NOT NULL DEFAULT 'STANDARD';
ALTER TABLE "Product" ADD CONSTRAINT "Product_combo_stock_check" CHECK ("kind" <> 'COMBO' OR ("stockQuantity" = 0 AND "reservedQuantity" = 0));
CREATE TABLE "PackVariant" (
 "id" TEXT PRIMARY KEY, "productId" TEXT NOT NULL REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "label" TEXT NOT NULL, "sku" TEXT NOT NULL, "unitsPerPack" INTEGER NOT NULL,
 "mrpPaise" INTEGER NOT NULL, "sellingPricePaise" INTEGER NOT NULL, "isActive" BOOLEAN NOT NULL DEFAULT true, "displayOrder" INTEGER NOT NULL DEFAULT 0,
 CONSTRAINT "PackVariant_units_check" CHECK ("unitsPerPack" BETWEEN 2 AND 10000),
 CONSTRAINT "PackVariant_prices_check" CHECK ("sellingPricePaise" >= 0 AND "mrpPaise" >= "sellingPricePaise")
);
CREATE UNIQUE INDEX "PackVariant_sku_key" ON "PackVariant"("sku");
CREATE UNIQUE INDEX "PackVariant_productId_unitsPerPack_key" ON "PackVariant"("productId","unitsPerPack");
CREATE TABLE "ComboComponent" (
 "id" TEXT PRIMARY KEY, "comboId" TEXT NOT NULL REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "productId" TEXT NOT NULL REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE, "quantity" INTEGER NOT NULL,
 CONSTRAINT "ComboComponent_quantity_check" CHECK ("quantity" BETWEEN 1 AND 10000 AND "comboId" <> "productId")
);
CREATE UNIQUE INDEX "ComboComponent_comboId_productId_key" ON "ComboComponent"("comboId","productId");
CREATE INDEX "ComboComponent_productId_idx" ON "ComboComponent"("productId");
ALTER TABLE "OrderItem" ADD COLUMN "variantId" TEXT REFERENCES "PackVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE, ADD COLUMN "packLabel" TEXT;
DROP INDEX "OrderItem_orderId_productId_key";
CREATE INDEX "OrderItem_orderId_productId_idx" ON "OrderItem"("orderId","productId");
CREATE UNIQUE INDEX "OrderItem_base_line_key" ON "OrderItem"("orderId","productId") WHERE "variantId" IS NULL;
CREATE UNIQUE INDEX "OrderItem_pack_line_key" ON "OrderItem"("orderId","productId","variantId") WHERE "variantId" IS NOT NULL;
CREATE TABLE "OrderItemComponent" (
 "id" TEXT PRIMARY KEY, "orderItemId" TEXT NOT NULL REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "productId" TEXT NOT NULL REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "productName" TEXT NOT NULL, "sku" TEXT NOT NULL, "unitsPerPack" INTEGER NOT NULL CHECK ("unitsPerPack" BETWEEN 1 AND 10000)
);
CREATE UNIQUE INDEX "OrderItemComponent_orderItemId_productId_key" ON "OrderItemComponent"("orderItemId","productId");
CREATE INDEX "OrderItemComponent_productId_idx" ON "OrderItemComponent"("productId");
CREATE TABLE "ReturnCaseItemComponent" (
 "id" TEXT PRIMARY KEY, "returnItemId" TEXT NOT NULL REFERENCES "ReturnCaseItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "productId" TEXT NOT NULL REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "productName" TEXT NOT NULL, "quantity" INTEGER NOT NULL CHECK ("quantity" > 0),
 "sellableQuantity" INTEGER NOT NULL DEFAULT 0, "conditionNote" TEXT,
 CONSTRAINT "ReturnCaseItemComponent_sellable_check" CHECK ("sellableQuantity" BETWEEN 0 AND "quantity")
);
CREATE UNIQUE INDEX "ReturnCaseItemComponent_returnItemId_productId_key" ON "ReturnCaseItemComponent"("returnItemId","productId");

-- For complete packs, zero fully sellable packs can still contain inspected
-- sellable physical units. Preserve legacy quantity constraints and explicitly
-- distinguish component inspections for the restocking guard.
ALTER TABLE "ReturnCaseItem" ADD COLUMN "componentInspection" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ReturnCaseItem" DROP CONSTRAINT "ReturnCaseItem_quantity_check";
ALTER TABLE "ReturnCaseItem" ADD CONSTRAINT "ReturnCaseItem_quantity_check" CHECK (
 "quantity" > 0 AND "receivedQuantity" BETWEEN 0 AND "quantity" AND "sellableQuantity" BETWEEN 0 AND "receivedQuantity"
 AND ("restockedAt" IS NULL OR "sellableQuantity" > 0 OR "componentInspection")
);
