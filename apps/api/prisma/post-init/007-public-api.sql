-- Public API (docs/public-api.md): RLS on its tables, sync triggers, log integrity.

-- ── RLS ─────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['api_keys', 'api_credit_ledger', 'deleted_records'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS rls_tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY rls_tenant_isolation ON public.%I USING (public.rls_tenant_allowed(tenant_id)) WITH CHECK (public.rls_tenant_allowed(tenant_id))',
      t);
  END LOOP;
END $$;

-- Tombstones of site-scoped rows follow the caller's site restriction (null site = tenant-wide row).
DROP POLICY IF EXISTS rls_site_scope ON public.deleted_records;
CREATE POLICY rls_site_scope ON public.deleted_records AS RESTRICTIVE
  USING (site_id IS NULL OR public.rls_site_allowed(site_id))
  WITH CHECK (site_id IS NULL OR public.rls_site_allowed(site_id));

-- Policies: the platform default (tenant_id null) is readable by every tenant context; writes are platform-only.
ALTER TABLE public.api_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_policy_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_policy_select ON public.api_policy_versions;
DROP POLICY IF EXISTS rls_policy_insert ON public.api_policy_versions;
CREATE POLICY rls_policy_select ON public.api_policy_versions FOR SELECT
  USING (tenant_id IS NULL OR public.rls_tenant_allowed(tenant_id));
CREATE POLICY rls_policy_insert ON public.api_policy_versions FOR INSERT WITH CHECK (public.rls_is_system());

-- Request logs: append-only like audit_logs. Rows without a tenant (rejected keys) are platform-only.
ALTER TABLE public.api_request_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_request_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_api_log_select ON public.api_request_logs;
DROP POLICY IF EXISTS rls_api_log_insert ON public.api_request_logs;
CREATE POLICY rls_api_log_select ON public.api_request_logs FOR SELECT USING (public.rls_tenant_allowed(tenant_id));
CREATE POLICY rls_api_log_insert ON public.api_request_logs FOR INSERT WITH CHECK (public.rls_is_system());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    REVOKE UPDATE, DELETE ON public.api_request_logs, public.api_policy_versions, public.api_credit_ledger, public.deleted_records FROM app_user;
  END IF;
END $$;

-- ── Sync: updated_at maintained in the database ─────────────────────────────
-- A trigger, not Prisma @updatedAt: raw-SQL writers (attendance recompute) bypass Prisma.
-- clock_timestamp() (write time, not transaction start) is what makes the sync cursor safe:
-- a row only gets its timestamp once its transaction holds an xid, so the cap in
-- public-api/sync.ts (oldest running write transaction) can never be passed by it.
CREATE OR REPLACE FUNCTION public.api_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := clock_timestamp() AT TIME ZONE 'UTC';
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.api_tombstone() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.deleted_records (tenant_id, resource, record_id, site_id, deleted_at)
  VALUES (OLD.tenant_id, TG_TABLE_NAME, OLD.id, to_jsonb(OLD) ->> 'site_id', clock_timestamp() AT TIME ZONE 'UTC');
  RETURN OLD;
END $$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sites', 'departments', 'employees', 'punches', 'attendance_days', 'leave_types', 'leave_requests'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS api_set_updated_at ON public.%I', t);
    EXECUTE format('CREATE TRIGGER api_set_updated_at BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.api_set_updated_at()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS api_tombstone ON public.%I', t);
    EXECUTE format('CREATE TRIGGER api_tombstone AFTER DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.api_tombstone()', t);
  END LOOP;
END $$;

-- ── Retention (runs as the owner: the app role can't delete these rows) ────
CREATE OR REPLACE FUNCTION public.api_purge(p_log_days int, p_tombstone_days int) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM public.api_request_logs WHERE created_at < (now() AT TIME ZONE 'UTC') - make_interval(days => p_log_days);
  DELETE FROM public.deleted_records WHERE deleted_at < (now() AT TIME ZONE 'UTC') - make_interval(days => p_tombstone_days);
$$;
REVOKE EXECUTE ON FUNCTION public.api_purge(int, int) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT EXECUTE ON FUNCTION public.api_purge(int, int) TO app_user;
  END IF;
END $$;
