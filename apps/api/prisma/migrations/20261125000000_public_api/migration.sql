-- Public API: keys, policy versions, request logs, credits; sync columns (updated_at, maintained by trigger in post-init/007) and tombstones.

-- AlterTable
ALTER TABLE "attendance_days" ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "departments" ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "external_id" TEXT;

-- AlterTable
ALTER TABLE "leave_requests" ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "leave_types" ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "punches" ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "sites" ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "hash_algo" TEXT NOT NULL DEFAULT 'hmac-sha256',
    "pepper_version" INTEGER NOT NULL DEFAULT 1,
    "last4" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "purpose" TEXT,
    "integrator_name" TEXT,
    "environment" TEXT NOT NULL DEFAULT 'live',
    "api_version" TEXT NOT NULL,
    "scopes" TEXT[],
    "site_ids" TEXT[],
    "ip_allowlist" TEXT[],
    "rate_limit_per_min" INTEGER,
    "credit_cap" INTEGER,
    "pii_access" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "disabled_reason" TEXT,
    "expires_at" TIMESTAMP(3),
    "rotated_from_id" TEXT,
    "last_used_at" TIMESTAMP(3),
    "last_used_ip" TEXT,
    "created_by" TEXT NOT NULL,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "revoked_by" TEXT,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_policy_versions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "version" INTEGER NOT NULL,
    "policy" JSONB,
    "note" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_policy_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_request_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "api_key_id" TEXT,
    "operation_id" TEXT,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "error_code" TEXT,
    "latency_ms" INTEGER NOT NULL,
    "req_bytes" INTEGER NOT NULL DEFAULT 0,
    "res_bytes" INTEGER NOT NULL DEFAULT 0,
    "ip" TEXT,
    "user_agent" TEXT,
    "credits" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_request_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_credit_ledger" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_credit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deleted_records" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "record_id" TEXT NOT NULL,
    "site_id" TEXT,
    "deleted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deleted_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_id_key" ON "api_keys"("key_id");

-- CreateIndex
CREATE INDEX "api_keys_tenant_id_status_idx" ON "api_keys"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "api_policy_versions_tenant_id_version_key" ON "api_policy_versions"("tenant_id", "version");

-- CreateIndex
CREATE INDEX "api_request_logs_tenant_id_created_at_idx" ON "api_request_logs"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "api_request_logs_api_key_id_created_at_idx" ON "api_request_logs"("api_key_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "api_credit_ledger_tenant_id_month_idx" ON "api_credit_ledger"("tenant_id", "month");

-- CreateIndex
CREATE INDEX "deleted_records_tenant_id_resource_deleted_at_record_id_idx" ON "deleted_records"("tenant_id", "resource", "deleted_at", "record_id");

-- CreateIndex
CREATE INDEX "attendance_days_tenant_id_updated_at_id_idx" ON "attendance_days"("tenant_id", "updated_at", "id");

-- CreateIndex
CREATE INDEX "departments_tenant_id_updated_at_id_idx" ON "departments"("tenant_id", "updated_at", "id");

-- CreateIndex
CREATE INDEX "employees_tenant_id_updated_at_id_idx" ON "employees"("tenant_id", "updated_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employees_tenant_id_external_id_key" ON "employees"("tenant_id", "external_id");

-- CreateIndex
CREATE INDEX "leave_requests_tenant_id_updated_at_id_idx" ON "leave_requests"("tenant_id", "updated_at", "id");

-- CreateIndex
CREATE INDEX "leave_types_tenant_id_updated_at_id_idx" ON "leave_types"("tenant_id", "updated_at", "id");

-- CreateIndex
CREATE INDEX "punches_tenant_id_updated_at_id_idx" ON "punches"("tenant_id", "updated_at", "id");

-- CreateIndex
CREATE INDEX "sites_tenant_id_updated_at_id_idx" ON "sites"("tenant_id", "updated_at", "id");

