-- Webhooks & event log (docs/public-api.md §10): RLS, and the transactional outbox.

-- ── RLS ─────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['api_events', 'webhook_endpoints', 'webhook_deliveries'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS rls_tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY rls_tenant_isolation ON public.%I USING (public.rls_tenant_allowed(tenant_id)) WITH CHECK (public.rls_tenant_allowed(tenant_id))',
      t);
  END LOOP;
END $$;

-- The event log follows a key's site restriction, like the resources it points at.
DROP POLICY IF EXISTS rls_site_scope ON public.api_events;
CREATE POLICY rls_site_scope ON public.api_events AS RESTRICTIVE
  USING (site_id IS NULL OR public.rls_site_allowed(site_id))
  WITH CHECK (site_id IS NULL OR public.rls_site_allowed(site_id));

-- The dispatcher's queue.
CREATE INDEX IF NOT EXISTS api_events_undispatched_idx ON public.api_events (created_at) WHERE dispatched_at IS NULL;

-- ── Outbox: events are written by triggers, in the transaction that made the change ──
-- Triggers cover every writer (terminal ingest, mobile, raw-SQL recompute, the API) without
-- each having to remember. Rows are only written for tenants that use the API (an active key
-- or a webhook endpoint), so orgs without integrations pay nothing.
-- SECURITY DEFINER (owner bypasses RLS): emitting must never fail the business write because
-- of the caller's site scope. api_emit is not callable by the app role; trigger functions
-- can't be called directly at all.
-- created_at uses clock_timestamp() for the same reason as updated_at (007): the event log
-- cursor is capped at the oldest running write transaction (public-api/sync.ts).
CREATE OR REPLACE FUNCTION public.api_emit(p_tenant text, p_site text, p_type text, p_data jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.api_events (id, tenant_id, site_id, type, data, created_at)
  SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), p_tenant, p_site, p_type, p_data, clock_timestamp() AT TIME ZONE 'UTC'
  WHERE EXISTS (SELECT 1 FROM public.webhook_endpoints WHERE tenant_id = p_tenant)
     OR EXISTS (SELECT 1 FROM public.api_keys WHERE tenant_id = p_tenant AND status = 'ACTIVE');
$$;
REVOKE EXECUTE ON FUNCTION public.api_emit(text, text, text, jsonb) FROM PUBLIC;
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['app_user', 'anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.api_emit(text, text, text, jsonb) FROM %I', r);
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.api_event_punch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.api_emit(NEW.tenant_id, NEW.site_id, 'punch.created', jsonb_build_object(
    'object', 'punch', 'id', NEW.id, 'employeeId', NEW.employee_id, 'siteId', NEW.site_id,
    'punchedAt', to_char(NEW.punched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  RETURN NULL;
END $$;

-- finalized: the day closed (finalized_at set). updated: a finalized day changed in anything
-- but its bookkeeping timestamps (recompute rewrites computed_at even when nothing changed).
CREATE OR REPLACE FUNCTION public.api_event_attendance_day() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  ev text;
BEGIN
  IF NEW.finalized_at IS NULL THEN
    RETURN NULL;
  ELSIF TG_OP = 'INSERT' OR OLD.finalized_at IS NULL THEN
    ev := 'attendance.day.finalized';
  ELSIF (to_jsonb(OLD) - ARRAY['updated_at', 'computed_at']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updated_at', 'computed_at']) THEN
    ev := 'attendance.day.updated';
  ELSE
    RETURN NULL;
  END IF;
  PERFORM public.api_emit(NEW.tenant_id, NEW.site_id, ev, jsonb_build_object(
    'object', 'attendance_day', 'id', NEW.id, 'employeeId', NEW.employee_id, 'siteId', NEW.site_id,
    'workDate', to_char(NEW.work_date, 'YYYY-MM-DD')));
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.api_event_leave_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  ev text;
  site text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    ev := 'leave.request.created';
  ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('APPROVED', 'REJECTED', 'CANCELLED') THEN
    ev := 'leave.request.decided';
  ELSE
    RETURN NULL;
  END IF;
  SELECT site_id INTO site FROM public.employees WHERE id = NEW.employee_id;
  PERFORM public.api_emit(NEW.tenant_id, site, ev, jsonb_build_object(
    'object', 'leave_request', 'id', NEW.id, 'employeeId', NEW.employee_id, 'leaveTypeId', NEW.leave_type_id, 'status', NEW.status));
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.api_event_employee() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  ev text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    ev := 'employee.created';
  ELSIF NEW.status = 'EXITED' AND OLD.status IS DISTINCT FROM 'EXITED' THEN
    ev := 'employee.exited';
  ELSIF (to_jsonb(OLD) - 'updated_at') IS DISTINCT FROM (to_jsonb(NEW) - 'updated_at') THEN
    ev := 'employee.updated';
  ELSE
    RETURN NULL;
  END IF;
  PERFORM public.api_emit(NEW.tenant_id, NEW.site_id, ev, jsonb_build_object(
    'object', 'employee', 'id', NEW.id, 'siteId', NEW.site_id, 'status', NEW.status));
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS api_event ON public.punches;
CREATE TRIGGER api_event AFTER INSERT ON public.punches FOR EACH ROW EXECUTE FUNCTION public.api_event_punch();
DROP TRIGGER IF EXISTS api_event ON public.attendance_days;
CREATE TRIGGER api_event AFTER INSERT OR UPDATE ON public.attendance_days FOR EACH ROW EXECUTE FUNCTION public.api_event_attendance_day();
DROP TRIGGER IF EXISTS api_event ON public.leave_requests;
CREATE TRIGGER api_event AFTER INSERT OR UPDATE ON public.leave_requests FOR EACH ROW EXECUTE FUNCTION public.api_event_leave_request();
DROP TRIGGER IF EXISTS api_event ON public.employees;
CREATE TRIGGER api_event AFTER INSERT OR UPDATE ON public.employees FOR EACH ROW EXECUTE FUNCTION public.api_event_employee();
