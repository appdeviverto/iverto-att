-- Additive only: two defaulted columns on api_keys and a new table. No existing row changes.
-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "require_signature" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "signing_public_key" TEXT;

-- CreateTable
CREATE TABLE "api_alerts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "api_key_id" TEXT,
    "type" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'warning',
    "message" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "api_alerts_tenant_id_created_at_idx" ON "api_alerts"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "api_alerts_tenant_id_type_created_at_idx" ON "api_alerts"("tenant_id", "type", "created_at");

