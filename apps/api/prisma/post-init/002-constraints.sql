-- Idempotent: every constraint is dropped and re-added.
-- Enum columns are strings in Prisma; the database is what keeps them honest.

CREATE OR REPLACE FUNCTION pg_temp.add_check(t text, name text, expr text) RETURNS void AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, name);
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s)', t, name, expr);
END $$ LANGUAGE plpgsql;

SELECT pg_temp.add_check('tenants', 'tenants_status_chk', $$status IN ('PROVISIONING','ACTIVE','SUSPENDED')$$);
SELECT pg_temp.add_check('user_profiles', 'user_profiles_role_chk', $$role IN ('ADMIN','HR','MANAGER','EMPLOYEE','PLATFORM_ADMIN')$$);
SELECT pg_temp.add_check('user_profiles', 'user_profiles_status_chk', $$status IN ('ACTIVE','DISABLED','EXITED')$$);
SELECT pg_temp.add_check('employees', 'employees_mobile_punch_chk', $$mobile_punch IN ('NEVER','REMOTE_DAYS','ALWAYS','FULL_REMOTE')$$);
SELECT pg_temp.add_check('employees', 'employees_status_chk', $$status IN ('ACTIVE','EXITED')$$);
SELECT pg_temp.add_check('devices', 'devices_direction_chk', $$direction IN ('IN','OUT','BOTH')$$);
SELECT pg_temp.add_check('punches', 'punches_source_chk', $$source IN ('TERMINAL','MOBILE','CORRECTION','MANUAL')$$);
SELECT pg_temp.add_check('punches', 'punches_direction_chk', $$direction IN ('in','out','unknown')$$);
SELECT pg_temp.add_check('punches', 'punches_manual_reason_chk', $$source <> 'MANUAL' OR reason IS NOT NULL$$);
SELECT pg_temp.add_check('punches', 'punches_review_status_chk', $$review_status IS NULL OR review_status IN ('PENDING','APPROVED','REJECTED')$$);
SELECT pg_temp.add_check('attendance_days', 'attendance_days_day_type_chk', $$day_type IN ('WORKING','WEEKLY_OFF','HOLIDAY')$$);
SELECT pg_temp.add_check('attendance_days', 'attendance_days_status_chk',
  $$status IN ('PENDING','PRESENT','HALF_DAY','ABSENT','ON_LEAVE','HALF_LEAVE','REMOTE','HOLIDAY','WEEKLY_OFF')$$);
SELECT pg_temp.add_check('shifts', 'shifts_kind_chk', $$kind IN ('FIXED','FLEXIBLE')$$);
SELECT pg_temp.add_check('employee_schedules', 'employee_schedules_one_source_chk',
  $$(shift_id IS NOT NULL AND pattern_id IS NULL) OR (shift_id IS NULL AND pattern_id IS NOT NULL AND anchor_date IS NOT NULL)$$);
SELECT pg_temp.add_check('leave_types', 'leave_types_accrual_chk', $$accrual_kind IN ('NONE','MONTHLY','YEARLY_UPFRONT','UNLIMITED')$$);
SELECT pg_temp.add_check('leave_types', 'leave_types_unit_chk', $$unit IN ('DAYS','HOURS') AND (unit = 'DAYS' OR accrual_kind = 'UNLIMITED')$$);
SELECT pg_temp.add_check('leave_requests', 'leave_requests_hours_chk', $$minutes IS NULL OR (minutes > 0 AND start_date = end_date AND start_time IS NOT NULL AND end_time IS NOT NULL)$$);
SELECT pg_temp.add_check('attendance_policies', 'attendance_policies_pairing_chk', $$pairing IN ('FIRST_LAST','ALTERNATE') AND absence_deduction >= 0$$);
SELECT pg_temp.add_check('sites', 'sites_geofence_chk', $$geofence_radius_m IS NULL OR (geofence_radius_m > 0 AND lat IS NOT NULL AND lng IS NOT NULL)$$);
SELECT pg_temp.add_check('leave_ledger', 'leave_ledger_kind_chk',
  $$kind IN ('OPENING','ACCRUAL','DEBIT','REVERSAL','ADJUSTMENT','CARRY_FORWARD','LAPSE','COMP_CREDIT')$$);
SELECT pg_temp.add_check('leave_requests', 'leave_requests_status_chk', $$status IN ('PENDING','APPROVED','REJECTED','CANCELLED')$$);
SELECT pg_temp.add_check('leave_requests', 'leave_requests_range_chk', $$end_date >= start_date$$);
SELECT pg_temp.add_check('remote_work_requests', 'remote_work_requests_status_chk', $$status IN ('PENDING','APPROVED','REJECTED','CANCELLED')$$);
SELECT pg_temp.add_check('remote_work_requests', 'remote_work_requests_range_chk', $$end_date >= start_date$$);
SELECT pg_temp.add_check('attendance_corrections', 'attendance_corrections_status_chk', $$status IN ('PENDING','APPROVED','REJECTED','CANCELLED')$$);
SELECT pg_temp.add_check('attendance_corrections', 'attendance_corrections_some_time_chk', $$in_at IS NOT NULL OR out_at IS NOT NULL$$);
SELECT pg_temp.add_check('attendance_policies', 'attendance_policies_late_deduction_chk', $$late_deduction IN ('NONE','HALF_DAY','FULL_DAY') AND late_deduction_every >= 1$$);
SELECT pg_temp.add_check('report_jobs', 'report_jobs_format_chk', $$format IN ('csv','pdf')$$);

-- Directory columns (nullable: existing employees have NULL, which every check allows).
SELECT pg_temp.add_check('employees', 'employees_gender_chk', $$gender IS NULL OR gender IN ('MALE','FEMALE','OTHER')$$);
SELECT pg_temp.add_check('employees', 'employees_marital_chk', $$marital_status IS NULL OR marital_status IN ('SINGLE','MARRIED','OTHER')$$);
SELECT pg_temp.add_check('employees', 'employees_payment_mode_chk', $$payment_mode IS NULL OR payment_mode IN ('BANK','CASH','CHEQUE')$$);
SELECT pg_temp.add_check('employees', 'employees_aadhaar_last4_chk', $$aadhaar_last4 IS NULL OR aadhaar_last4 ~ '^[0-9]{4}$'$$);
SELECT pg_temp.add_check('employees', 'employees_pan_chk', $$pan IS NULL OR pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'$$);
SELECT pg_temp.add_check('employees', 'employees_ifsc_chk', $$bank_ifsc IS NULL OR bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'$$);
SELECT pg_temp.add_check('employees', 'employees_uan_chk', $$uan IS NULL OR uan ~ '^[0-9]{12}$'$$);

-- HR & payroll
SELECT pg_temp.add_check('profile_change_requests', 'profile_change_requests_status_chk', $$status IN ('PENDING','APPROVED','REJECTED','CANCELLED')$$);
SELECT pg_temp.add_check('employee_tasks', 'employee_tasks_kind_chk', $$kind IN ('ONBOARDING','OFFBOARDING') AND assignee_role IN ('HR','IT','MANAGER','EMPLOYEE')$$);
SELECT pg_temp.add_check('letter_templates', 'letter_templates_kind_chk', $$kind IN ('OFFER','APPOINTMENT','EXPERIENCE','RELIEVING','OTHER')$$);
SELECT pg_temp.add_check('expense_claims', 'expense_claims_status_chk', $$status IN ('PENDING','APPROVED','REJECTED','CANCELLED') AND amount > 0$$);
SELECT pg_temp.add_check('assets', 'assets_status_chk', $$status IN ('IN_STOCK','ASSIGNED','RETIRED') AND (status = 'ASSIGNED') = (employee_id IS NOT NULL)$$);
SELECT pg_temp.add_check('platform_announcements', 'platform_announcements_kind_chk', $$kind IN ('UPDATE','FEATURE','CHANGELOG')$$);
SELECT pg_temp.add_check('employee_salaries', 'employee_salaries_gross_chk', $$monthly_gross >= 0$$);
SELECT pg_temp.add_check('payroll_adjustments', 'payroll_adjustments_kind_chk', $$kind IN ('EARNING','DEDUCTION') AND amount > 0 AND month ~ '^[0-9]{4}-[0-9]{2}$'$$);
SELECT pg_temp.add_check('employee_loans', 'employee_loans_chk', $$status IN ('ACTIVE','CLOSED') AND principal > 0 AND emi > 0 AND start_month ~ '^[0-9]{4}-[0-9]{2}$'$$);
SELECT pg_temp.add_check('payroll_runs', 'payroll_runs_chk', $$status IN ('DRAFT','APPROVED','PAID') AND period_end >= period_start AND month ~ '^[0-9]{4}-[0-9]{2}$'$$);
SELECT pg_temp.add_check('payslips', 'payslips_payment_mode_chk', $$payment_mode IN ('BANK','CASH','CHEQUE')$$);

-- No overlapping live requests / schedules per employee: a DB constraint, not app code (§8.2).
ALTER TABLE leave_requests DROP CONSTRAINT IF EXISTS leave_requests_no_overlap;
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_no_overlap
  EXCLUDE USING gist (employee_id WITH =, daterange(start_date, end_date, '[]') WITH &&)
  WHERE (status IN ('PENDING','APPROVED'));

ALTER TABLE remote_work_requests DROP CONSTRAINT IF EXISTS remote_work_requests_no_overlap;
ALTER TABLE remote_work_requests ADD CONSTRAINT remote_work_requests_no_overlap
  EXCLUDE USING gist (employee_id WITH =, daterange(start_date, end_date, '[]') WITH &&)
  WHERE (status IN ('PENDING','APPROVED'));

ALTER TABLE employee_schedules DROP CONSTRAINT IF EXISTS employee_schedules_no_overlap;
ALTER TABLE employee_schedules ADD CONSTRAINT employee_schedules_no_overlap
  EXCLUDE USING gist (employee_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&);

-- Audit trail is append-only.
CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_no_mutation ON audit_logs;
CREATE TRIGGER audit_logs_no_mutation BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();
