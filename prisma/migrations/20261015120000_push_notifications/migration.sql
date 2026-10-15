-- Additive only. No existing table, row or constraint is changed.
CREATE TYPE "NotificationEventStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED');
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'SKIPPED');
CREATE TYPE "DevicePlatform" AS ENUM ('ANDROID', 'IOS');
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('SENT', 'FAILED');

CREATE TABLE "NotificationProviderConfig" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "isEnabled" BOOLEAN NOT NULL DEFAULT false,
  "projectId" TEXT, "clientEmail" TEXT, "privateKeyId" TEXT, "credentialEncrypted" TEXT,
  "lastTestAt" TIMESTAMP(3), "lastTestOk" BOOLEAN, "lastTestMessage" TEXT,
  "lastSuccessAt" TIMESTAMP(3), "lastFailureAt" TIMESTAMP(3), "lastFailureMessage" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL, "updatedByAdminId" TEXT,
  CONSTRAINT "NotificationProviderConfig_singleton_check" CHECK ("id" = 'fcm'),
  CONSTRAINT "NotificationProviderConfig_enabled_check" CHECK ("isEnabled" = false OR "credentialEncrypted" IS NOT NULL)
);

CREATE TABLE "NotificationTemplate" (
  "id" TEXT NOT NULL PRIMARY KEY, "key" TEXT NOT NULL, "name" TEXT NOT NULL, "eventKey" TEXT NOT NULL,
  "title" TEXT NOT NULL, "body" TEXT NOT NULL, "imageUrl" TEXT, "targetScreen" TEXT, "metadata" JSONB,
  "isEnabled" BOOLEAN NOT NULL DEFAULT false, "createdByAdminId" TEXT, "updatedByAdminId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "NotificationTemplate_key_key" ON "NotificationTemplate"("key");
CREATE INDEX "NotificationTemplate_eventKey_isEnabled_idx" ON "NotificationTemplate"("eventKey", "isEnabled");
-- At most one enabled template per event, so one event can never send two pushes.
CREATE UNIQUE INDEX "NotificationTemplate_one_enabled_per_event" ON "NotificationTemplate"("eventKey") WHERE "isEnabled" = true;

CREATE TABLE "NotificationEventSetting" (
  "eventKey" TEXT NOT NULL PRIMARY KEY, "isEnabled" BOOLEAN NOT NULL DEFAULT true,
  "updatedAt" TIMESTAMP(3) NOT NULL, "updatedByAdminId" TEXT
);

CREATE TABLE "DeviceRegistration" (
  "id" TEXT NOT NULL PRIMARY KEY, "accountId" TEXT NOT NULL, "installationId" TEXT NOT NULL,
  "token" TEXT NOT NULL, "platform" "DevicePlatform" NOT NULL, "appVersion" TEXT,
  "lastRegisteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "invalidatedAt" TIMESTAMP(3), "invalidReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DeviceRegistration_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DeviceRegistration_installationId_key" ON "DeviceRegistration"("installationId");
CREATE UNIQUE INDEX "DeviceRegistration_token_key" ON "DeviceRegistration"("token");
CREATE INDEX "DeviceRegistration_accountId_invalidatedAt_idx" ON "DeviceRegistration"("accountId", "invalidatedAt");

CREATE TABLE "NotificationEvent" (
  "id" TEXT NOT NULL PRIMARY KEY, "eventKey" TEXT NOT NULL, "dedupKey" TEXT NOT NULL,
  "accountId" TEXT, "entityType" TEXT NOT NULL, "entityId" TEXT NOT NULL, "payload" JSONB NOT NULL,
  "status" "NotificationEventStatus" NOT NULL DEFAULT 'PENDING', "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "lockedUntil" TIMESTAMP(3),
  "lastError" TEXT, "processedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "NotificationEvent_dedupKey_key" ON "NotificationEvent"("dedupKey");
CREATE INDEX "NotificationEvent_status_nextAttemptAt_idx" ON "NotificationEvent"("status", "nextAttemptAt");
CREATE INDEX "NotificationEvent_createdAt_idx" ON "NotificationEvent"("createdAt");

CREATE TABLE "Notification" (
  "id" TEXT NOT NULL PRIMARY KEY, "eventId" TEXT, "accountId" TEXT NOT NULL, "eventKey" TEXT NOT NULL,
  "templateId" TEXT, "templateKey" TEXT, "templateName" TEXT,
  "title" TEXT NOT NULL, "body" TEXT NOT NULL, "pushTitle" TEXT NOT NULL, "pushBody" TEXT NOT NULL,
  "imageUrl" TEXT, "targetScreen" TEXT NOT NULL, "targetParams" JSONB,
  "entityType" TEXT, "entityId" TEXT, "reference" TEXT, "isTest" BOOLEAN NOT NULL DEFAULT false,
  "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING', "errorCategory" TEXT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0, "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedUntil" TIMESTAMP(3), "processedAt" TIMESTAMP(3), "sentAt" TIMESTAMP(3), "fcmMessageId" TEXT,
  "readAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Notification_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "NotificationEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "Notification_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Notification_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "NotificationTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "Notification_attempt_check" CHECK ("attemptCount" >= 0)
);
CREATE UNIQUE INDEX "Notification_eventId_key" ON "Notification"("eventId");
CREATE INDEX "Notification_accountId_createdAt_id_idx" ON "Notification"("accountId", "createdAt", "id");
CREATE INDEX "Notification_accountId_readAt_idx" ON "Notification"("accountId", "readAt");
CREATE INDEX "Notification_status_nextAttemptAt_idx" ON "Notification"("status", "nextAttemptAt");
CREATE INDEX "Notification_eventKey_createdAt_idx" ON "Notification"("eventKey", "createdAt");
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

CREATE TABLE "NotificationDelivery" (
  "id" TEXT NOT NULL PRIMARY KEY, "notificationId" TEXT NOT NULL, "deviceId" TEXT,
  "tokenSuffix" TEXT NOT NULL, "attempt" INTEGER NOT NULL, "status" "NotificationDeliveryStatus" NOT NULL,
  "fcmMessageId" TEXT, "errorCategory" TEXT, "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NotificationDelivery_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "NotificationDelivery_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "DeviceRegistration"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "NotificationDelivery_notificationId_idx" ON "NotificationDelivery"("notificationId");
CREATE INDEX "NotificationDelivery_createdAt_idx" ON "NotificationDelivery"("createdAt");
