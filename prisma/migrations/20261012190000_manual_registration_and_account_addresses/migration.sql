-- Additive migration: existing accounts, sessions, guest records and orders are retained.
ALTER TABLE "Account"
  ADD COLUMN "mobile" TEXT,
  ADD COLUMN "mobileVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "termsAcceptedAt" TIMESTAMP(3);

CREATE TYPE "EmailOtpPurpose" AS ENUM ('LOGIN', 'REGISTRATION');
ALTER TABLE "EmailOtp"
  ADD COLUMN "purpose" "EmailOtpPurpose" NOT NULL DEFAULT 'LOGIN',
  ADD COLUMN "registrationData" JSONB;

CREATE TABLE "AccountAddress" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "fullName" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "addressLine1" TEXT NOT NULL,
  "addressLine2" TEXT,
  "landmark" TEXT,
  "city" TEXT NOT NULL,
  "pincode" TEXT NOT NULL,
  "deliveryAreaId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AccountAddress_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountAddress_label_check" CHECK ("label" IN ('Home', 'Work', 'Other')),
  CONSTRAINT "AccountAddress_pincode_check" CHECK ("pincode" ~ '^[1-9][0-9]{5}$'),
  CONSTRAINT "AccountAddress_phone_check" CHECK ("phone" ~ '^[6-9][0-9]{9}$')
);
CREATE INDEX "AccountAddress_accountId_createdAt_id_idx" ON "AccountAddress"("accountId", "createdAt", "id");
CREATE INDEX "AccountAddress_deliveryAreaId_idx" ON "AccountAddress"("deliveryAreaId");
CREATE UNIQUE INDEX "AccountAddress_accountId_default_key" ON "AccountAddress"("accountId") WHERE "isDefault" = true;
ALTER TABLE "AccountAddress" ADD CONSTRAINT "AccountAddress_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountAddress" ADD CONSTRAINT "AccountAddress_deliveryAreaId_fkey"
  FOREIGN KEY ("deliveryAreaId") REFERENCES "DeliveryArea"("id") ON DELETE SET NULL ON UPDATE CASCADE;
