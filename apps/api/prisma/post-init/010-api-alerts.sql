-- Public API usage alerts (docs/public-api.md §15).

DO $$
BEGIN
  ALTER TABLE public.api_alerts DROP CONSTRAINT IF EXISTS api_alerts_level_chk;
  ALTER TABLE public.api_alerts ADD CONSTRAINT api_alerts_level_chk CHECK (level IN ('warning', 'critical'));
END $$;

ALTER TABLE public.api_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_alerts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_tenant_isolation ON public.api_alerts;
CREATE POLICY rls_tenant_isolation ON public.api_alerts
  USING (public.rls_tenant_allowed(tenant_id)) WITH CHECK (public.rls_tenant_allowed(tenant_id));
