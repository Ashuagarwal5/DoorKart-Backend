-- Additive only. Existing fulfillment, payments, stock and historical rows are not changed.
CREATE TYPE "ReturnCaseKind" AS ENUM ('RETURN_ONLY', 'REFUND_ONLY', 'RETURN_REFUND');
CREATE TYPE "ReturnCaseStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'COMPLETED');
CREATE TABLE "ReturnCase" (
 "id" TEXT NOT NULL PRIMARY KEY, "orderId" TEXT NOT NULL,
 "clientRequestId" TEXT NOT NULL, "requestFingerprint" TEXT NOT NULL,
 "kind" "ReturnCaseKind" NOT NULL, "status" "ReturnCaseStatus" NOT NULL DEFAULT 'REQUESTED',
 "reason" TEXT NOT NULL, "requestedAmountPaise" INTEGER NOT NULL, "approvedAmountPaise" INTEGER,
 "payoutReference" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "approvedAt" TIMESTAMP(3), "rejectedAt" TIMESTAMP(3), "receivedAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3), "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "ReturnCase_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "ReturnCase_amount_check" CHECK (
   "requestedAmountPaise" >= 0 AND ("approvedAmountPaise" IS NULL OR "approvedAmountPaise" BETWEEN 0 AND "requestedAmountPaise") AND
   (("kind" = 'RETURN_ONLY' AND "requestedAmountPaise" = 0 AND ("approvedAmountPaise" IS NULL OR "approvedAmountPaise" = 0)) OR
    ("kind" <> 'RETURN_ONLY' AND "requestedAmountPaise" > 0 AND ("approvedAmountPaise" IS NULL OR "approvedAmountPaise" > 0)))
 ),
 CONSTRAINT "ReturnCase_state_check" CHECK (
   ("status" NOT IN ('APPROVED','COMPLETED') OR ("approvedAmountPaise" IS NOT NULL AND "approvedAt" IS NOT NULL)) AND
   ("status" <> 'REJECTED' OR "rejectedAt" IS NOT NULL) AND
   ("status" <> 'COMPLETED' OR ("completedAt" IS NOT NULL AND ("kind" = 'RETURN_ONLY' OR ("payoutReference" IS NOT NULL AND length(trim("payoutReference")) > 0)) AND ("kind" = 'REFUND_ONLY' OR "receivedAt" IS NOT NULL)))
 )
);
CREATE UNIQUE INDEX "ReturnCase_clientRequestId_key" ON "ReturnCase"("clientRequestId");
CREATE UNIQUE INDEX "ReturnCase_payoutReference_key" ON "ReturnCase"("payoutReference");
-- Also protects against two tabs or callers using different request IDs.
CREATE UNIQUE INDEX "ReturnCase_one_open_per_order" ON "ReturnCase"("orderId") WHERE "status" IN ('REQUESTED','APPROVED');
CREATE INDEX "ReturnCase_orderId_createdAt_id_idx" ON "ReturnCase"("orderId","createdAt","id");
CREATE INDEX "ReturnCase_status_createdAt_id_idx" ON "ReturnCase"("status","createdAt","id");
CREATE INDEX "ReturnCase_completedAt_idx" ON "ReturnCase"("completedAt");
CREATE TABLE "ReturnCaseItem" (
 "id" TEXT NOT NULL PRIMARY KEY, "caseId" TEXT NOT NULL, "orderItemId" TEXT NOT NULL, "quantity" INTEGER NOT NULL,
 "receivedQuantity" INTEGER NOT NULL DEFAULT 0, "sellableQuantity" INTEGER NOT NULL DEFAULT 0,
 "conditionNote" TEXT, "restockedAt" TIMESTAMP(3),
 CONSTRAINT "ReturnCaseItem_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ReturnCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "ReturnCaseItem_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "ReturnCaseItem_quantity_check" CHECK ("quantity" > 0 AND "receivedQuantity" BETWEEN 0 AND "quantity" AND "sellableQuantity" BETWEEN 0 AND "receivedQuantity" AND ("restockedAt" IS NULL OR "sellableQuantity" > 0))
);
CREATE UNIQUE INDEX "ReturnCaseItem_caseId_orderItemId_key" ON "ReturnCaseItem"("caseId","orderItemId");
CREATE INDEX "ReturnCaseItem_orderItemId_idx" ON "ReturnCaseItem"("orderItemId");
CREATE TABLE "ReturnCaseEvent" (
 "id" TEXT NOT NULL PRIMARY KEY, "caseId" TEXT NOT NULL, "requestId" TEXT NOT NULL, "requestFingerprint" TEXT NOT NULL,
 "action" TEXT NOT NULL, "adminId" TEXT NOT NULL, "adminName" TEXT NOT NULL, "note" TEXT NOT NULL, "details" JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ReturnCaseEvent_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ReturnCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "ReturnCaseEvent_action_check" CHECK ("action" IN ('REQUEST','APPROVE','REJECT','RECEIVE','RESTOCK','COMPLETE'))
);
CREATE UNIQUE INDEX "ReturnCaseEvent_caseId_requestId_key" ON "ReturnCaseEvent"("caseId","requestId");
CREATE INDEX "ReturnCaseEvent_caseId_createdAt_id_idx" ON "ReturnCaseEvent"("caseId","createdAt","id");
