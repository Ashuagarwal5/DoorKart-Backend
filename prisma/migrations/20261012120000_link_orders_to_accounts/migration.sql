-- Additive only: existing guest orders remain NULL. No email/phone-based backfill.
ALTER TABLE "Order" ADD COLUMN "accountId" TEXT;

CREATE INDEX "Order_accountId_createdAt_id_idx" ON "Order"("accountId", "createdAt", "id");

-- Account deletion preserves commerce records and existing guest tracking credentials.
ALTER TABLE "Order" ADD CONSTRAINT "Order_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
