-- A correction can carry several field visits as proof (one per client visited).
ALTER TABLE "attendance_corrections" ADD COLUMN "field_visit_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Keep the proof already attached.
UPDATE "attendance_corrections" SET "field_visit_ids" = ARRAY["field_visit_id"] WHERE "field_visit_id" IS NOT NULL;

ALTER TABLE "attendance_corrections" DROP CONSTRAINT "attendance_corrections_field_visit_id_fkey";
ALTER TABLE "attendance_corrections" DROP COLUMN "field_visit_id";
