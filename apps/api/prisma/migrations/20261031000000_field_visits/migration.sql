-- CreateTable
CREATE TABLE "field_visits" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "taken_at" TIMESTAMPTZ(3) NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL,
    "is_mock_location" BOOLEAN,
    "photo_key" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "field_visits_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "attendance_corrections" ADD COLUMN     "field_visit_id" TEXT;

-- CreateIndex
CREATE INDEX "field_visits_employee_id_taken_at_idx" ON "field_visits"("employee_id", "taken_at");

-- AddForeignKey
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_field_visit_id_fkey" FOREIGN KEY ("field_visit_id") REFERENCES "field_visits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_visits" ADD CONSTRAINT "field_visits_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
