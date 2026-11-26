-- Public API jobs (docs/public-api.md §12): RLS, report status sync, job.completed events.

ALTER TABLE public.api_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_tenant_isolation ON public.api_jobs;
CREATE POLICY rls_tenant_isolation ON public.api_jobs
  USING (public.rls_tenant_allowed(tenant_id)) WITH CHECK (public.rls_tenant_allowed(tenant_id));

-- A report job's status follows its ReportJob, whichever code path moves it. A failed first
-- attempt may be retried by the report queue, so FAILED can still become SUCCEEDED.
CREATE OR REPLACE FUNCTION public.api_job_from_report() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  now_utc timestamp := clock_timestamp() AT TIME ZONE 'UTC';
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('RUNNING', 'READY', 'FAILED') THEN
    UPDATE public.api_jobs SET
      status = CASE NEW.status WHEN 'RUNNING' THEN 'RUNNING' WHEN 'READY' THEN 'SUCCEEDED' ELSE 'FAILED' END,
      started_at = COALESCE(started_at, now_utc),
      completed_at = CASE WHEN NEW.status = 'RUNNING' THEN NULL ELSE now_utc END
    WHERE report_job_id = NEW.id AND status <> 'SUCCEEDED';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS api_job_from_report ON public.report_jobs;
CREATE TRIGGER api_job_from_report AFTER UPDATE ON public.report_jobs FOR EACH ROW EXECUTE FUNCTION public.api_job_from_report();

-- job.completed whenever a job reaches a terminal status (outbox: same transaction).
CREATE OR REPLACE FUNCTION public.api_event_job() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status IN ('SUCCEEDED', 'PARTIALLY_SUCCEEDED', 'FAILED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM public.api_emit(NEW.tenant_id, NULL, 'job.completed', jsonb_build_object(
      'object', 'job', 'id', NEW.id, 'type', NEW.type, 'status', lower(NEW.status)));
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS api_event ON public.api_jobs;
CREATE TRIGGER api_event AFTER UPDATE ON public.api_jobs FOR EACH ROW EXECUTE FUNCTION public.api_event_job();
