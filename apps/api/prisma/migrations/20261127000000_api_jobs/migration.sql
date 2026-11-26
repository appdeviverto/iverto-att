-- CreateTable
CREATE TABLE "api_jobs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "api_key_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "input" JSONB NOT NULL,
    "progress" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "error" JSONB,
    "report_job_id" TEXT,
    "checkpoint" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_jobs_report_job_id_key" ON "api_jobs"("report_job_id");

-- CreateIndex
CREATE INDEX "api_jobs_tenant_id_created_at_id_idx" ON "api_jobs"("tenant_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "api_jobs_status_type_idx" ON "api_jobs"("status", "type");

