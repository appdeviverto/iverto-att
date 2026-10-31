-- Close the Supabase Data API (PostgREST / GraphQL) over the public schema.
--
-- Only the API touches these tables, as app_user (005) under RLS (003). Clients use
-- Supabase for Auth only, so the anon key that ships in the web bundle must reach
-- nothing here. Supabase's default grants give anon/authenticated full DML on every
-- public table, which left anything without RLS (e.g. _prisma_migrations) readable
-- and writable by anyone holding the project URL.

-- 1. Fail closed: every table in public has RLS, including ones 003 doesn't know
--    about yet. No policy = no rows for any role without BYPASSRLS, so a new table
--    someone forgets to add to 003 breaks loudly instead of leaking.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- Migration history is for the migration role (BYPASSRLS) only.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    REVOKE ALL ON public._prisma_migrations FROM app_user;
  END IF;
END $$;

-- 2. No Data API access at all for the Supabase client roles.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE USAGE ON SCHEMA public FROM %I', r);
      -- …and none on objects created later by the migration role.
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- PUBLIC (every role) gets schema USAGE and function EXECUTE by default; keep both
-- to the roles that need them. app_user's grants in 005 are explicit, so unaffected.
REVOKE USAGE ON SCHEMA public FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
