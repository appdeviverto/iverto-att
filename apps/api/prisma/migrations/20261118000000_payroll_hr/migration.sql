-- Additive only: new tables, and nullable columns on employees. No existing column or row is changed.
-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "aadhaar_last4" TEXT,
ADD COLUMN     "alt_phone" TEXT,
ADD COLUMN     "bank_account_name" TEXT,
ADD COLUMN     "bank_account_number" TEXT,
ADD COLUMN     "bank_ifsc" TEXT,
ADD COLUMN     "bank_name" TEXT,
ADD COLUMN     "blood_group" TEXT,
ADD COLUMN     "confirmed_on" DATE,
ADD COLUMN     "current_address" TEXT,
ADD COLUMN     "date_of_birth" DATE,
ADD COLUMN     "emergency_name" TEXT,
ADD COLUMN     "emergency_phone" TEXT,
ADD COLUMN     "emergency_relation" TEXT,
ADD COLUMN     "esic_number" TEXT,
ADD COLUMN     "father_or_spouse_name" TEXT,
ADD COLUMN     "gender" TEXT,
ADD COLUMN     "marital_status" TEXT,
ADD COLUMN     "notice_period_days" INTEGER,
ADD COLUMN     "pan" TEXT,
ADD COLUMN     "payment_mode" TEXT,
ADD COLUMN     "permanent_address" TEXT,
ADD COLUMN     "personal_email" TEXT,
ADD COLUMN     "probation_end_on" DATE,
ADD COLUMN     "uan" TEXT;

-- CreateTable
CREATE TABLE "profile_change_requests" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "approver_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profile_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_documents" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "file_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "expires_on" DATE,
    "verified_at" TIMESTAMP(3),
    "verified_by" TEXT,
    "uploaded_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "letter_templates" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "letter_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_tasks" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "assignee_role" TEXT NOT NULL,
    "due_on" DATE,
    "done_at" TIMESTAMP(3),
    "done_by" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_claims" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "claim_date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "receipt_key" TEXT,
    "receipt_type" TEXT,
    "field_visit_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "manager_approver_id" TEXT,
    "manager_decided_at" TIMESTAMP(3),
    "approver_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "created_by" TEXT,
    "payslip_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expense_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "serial_no" TEXT,
    "status" TEXT NOT NULL DEFAULT 'IN_STOCK',
    "employee_id" TEXT,
    "assigned_at" TIMESTAMP(3),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcements" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "site_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "department_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requires_ack" BOOLEAN NOT NULL DEFAULT false,
    "published_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcement_acks" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "announcement_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "ack_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcement_acks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_structures" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "components" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salary_structures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_salaries" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "effective_from" DATE NOT NULL,
    "structure_id" TEXT NOT NULL,
    "monthly_gross" INTEGER NOT NULL,
    "overrides" JSONB NOT NULL DEFAULT '{}',
    "pf" BOOLEAN NOT NULL DEFAULT true,
    "esi" BOOLEAN NOT NULL DEFAULT true,
    "pt" BOOLEAN NOT NULL DEFAULT true,
    "pt_state" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_salaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_adjustments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "note" TEXT,
    "payslip_id" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_loans" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "principal" INTEGER NOT NULL,
    "emi" INTEGER NOT NULL,
    "start_month" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "locked_at" TIMESTAMP(3),
    "totals" JSONB NOT NULL DEFAULT '{}',
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "paid_by" TEXT,
    "paid_at" TIMESTAMP(3),

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslips" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "attendance" JSONB NOT NULL,
    "lines" JSONB NOT NULL,
    "gross" INTEGER NOT NULL,
    "deductions" INTEGER NOT NULL,
    "net" INTEGER NOT NULL,
    "employer_contrib" INTEGER NOT NULL,
    "payment_mode" TEXT NOT NULL DEFAULT 'BANK',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payslips_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "profile_change_requests_tenant_id_status_idx" ON "profile_change_requests"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "profile_change_requests_employee_id_idx" ON "profile_change_requests"("employee_id");

-- CreateIndex
CREATE INDEX "employee_documents_employee_id_idx" ON "employee_documents"("employee_id");

-- CreateIndex
CREATE INDEX "employee_documents_tenant_id_expires_on_idx" ON "employee_documents"("tenant_id", "expires_on");

-- CreateIndex
CREATE UNIQUE INDEX "letter_templates_tenant_id_name_key" ON "letter_templates"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "employee_tasks_employee_id_idx" ON "employee_tasks"("employee_id");

-- CreateIndex
CREATE INDEX "employee_tasks_tenant_id_done_at_idx" ON "employee_tasks"("tenant_id", "done_at");

-- CreateIndex
CREATE INDEX "expense_claims_tenant_id_status_idx" ON "expense_claims"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "expense_claims_employee_id_claim_date_idx" ON "expense_claims"("employee_id", "claim_date");

-- CreateIndex
CREATE INDEX "assets_employee_id_idx" ON "assets"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "assets_tenant_id_tag_key" ON "assets"("tenant_id", "tag");

-- CreateIndex
CREATE INDEX "announcements_tenant_id_published_at_idx" ON "announcements"("tenant_id", "published_at");

-- CreateIndex
CREATE UNIQUE INDEX "announcement_acks_announcement_id_employee_id_key" ON "announcement_acks"("announcement_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "salary_structures_tenant_id_name_key" ON "salary_structures"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "employee_salaries_employee_id_effective_from_key" ON "employee_salaries"("employee_id", "effective_from");

-- CreateIndex
CREATE INDEX "payroll_adjustments_tenant_id_month_idx" ON "payroll_adjustments"("tenant_id", "month");

-- CreateIndex
CREATE INDEX "employee_loans_employee_id_idx" ON "employee_loans"("employee_id");

-- CreateIndex
CREATE INDEX "payroll_runs_tenant_id_period_start_idx" ON "payroll_runs"("tenant_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_tenant_id_month_key" ON "payroll_runs"("tenant_id", "month");

-- CreateIndex
CREATE INDEX "payslips_employee_id_idx" ON "payslips"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "payslips_run_id_employee_id_key" ON "payslips"("run_id", "employee_id");

-- AddForeignKey
ALTER TABLE "profile_change_requests" ADD CONSTRAINT "profile_change_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_tasks" ADD CONSTRAINT "employee_tasks_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_acks" ADD CONSTRAINT "announcement_acks_announcement_id_fkey" FOREIGN KEY ("announcement_id") REFERENCES "announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_salaries" ADD CONSTRAINT "employee_salaries_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_salaries" ADD CONSTRAINT "employee_salaries_structure_id_fkey" FOREIGN KEY ("structure_id") REFERENCES "salary_structures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_loans" ADD CONSTRAINT "employee_loans_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

