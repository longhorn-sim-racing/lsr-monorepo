-- ---------------------------------------------------------------------------
-- Jack's read-only SQL role (#161).
--
-- Jack (the officer chat agent) writes his own SELECTs. They run as `jack_readonly` through a
-- separate connection string (JACK_DATABASE_URL), so the database itself, not the prompt, decides
-- what he can do: read public tables, and nothing else.
--
-- - The role is created NOLOGIN. Production turns on login with a password by hand (never in git):
--     ALTER ROLE jack_readonly LOGIN PASSWORD '…';
--   Locally, scripts/jack-local-sql-role.ts does it.
-- - SELECT on every table in schema public, except "SystemSetting" (it holds the Instagram access
--   token and other secrets) and "_prisma_migrations".
-- - Tables created later by the migration user are readable too (default privileges below).
--   ANY FUTURE TABLE THAT HOLDS SECRETS MUST REVOKE IT IN ITS OWN MIGRATION:
--     REVOKE ALL ON public."NewTable" FROM jack_readonly;
-- - No access to Supabase's auth, storage, realtime or vault schemas, or to jack_private. It's never
--   granted; the checks at the end fail this migration if it somehow is.
-- - Every session is read-only with a short statement timeout. The tool also wraps each query in
--   its own READ ONLY transaction with SET LOCAL statement_timeout, since a session setting can be
--   changed from inside a query (set_config) and pooled connections are reused.
--
-- Idempotent, and safe on Prisma's shadow database: roles are cluster-wide, so a rerun finds the
-- role and only re-applies grants and settings (it never touches LOGIN or the password). Where the
-- migration user can't create roles and this isn't Supabase (no auth schema), it skips with a
-- notice; on Supabase it fails instead, so production never silently goes without the role.
-- ---------------------------------------------------------------------------
DO $jack$
DECLARE
  s text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jack_readonly') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolcreaterole OR rolsuper)) THEN
      IF to_regnamespace('auth') IS NULL THEN
        RAISE NOTICE '% cannot create roles and this is not Supabase; skipping jack_readonly', current_user;
        RETURN;
      END IF;
      RAISE EXCEPTION '% cannot create the jack_readonly role (needs CREATEROLE)', current_user;
    END IF;
    CREATE ROLE jack_readonly NOLOGIN NOINHERIT CONNECTION LIMIT 5;
  ELSE
    ALTER ROLE jack_readonly CONNECTION LIMIT 5;
  END IF;

  -- Every session as jack_readonly starts read-only, gives up on slow queries, and doesn't hold a
  -- transaction open
  ALTER ROLE jack_readonly SET default_transaction_read_only = on;
  ALTER ROLE jack_readonly SET statement_timeout = '5s';
  ALTER ROLE jack_readonly SET idle_in_transaction_session_timeout = '10s';
  ALTER ROLE jack_readonly SET search_path = public;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO jack_readonly', current_database());
  GRANT USAGE ON SCHEMA public TO jack_readonly;
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO jack_readonly;

  -- Tables the migration user creates later are readable too. A table that holds secrets must
  -- REVOKE this in the migration that creates it (see the header).
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO jack_readonly;

  -- Secrets and migration history stay out of reach
  IF to_regclass('public."SystemSetting"') IS NOT NULL THEN
    REVOKE ALL ON TABLE public."SystemSetting" FROM jack_readonly;
  END IF;
  IF to_regclass('public."_prisma_migrations"') IS NOT NULL THEN
    REVOKE ALL ON TABLE public."_prisma_migrations" FROM jack_readonly;
  END IF;

  -- Checks: fail the migration rather than leave the role able to do more than read public tables
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'jack_readonly' AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'jack_readonly has role attributes it must not have';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member = 'jack_readonly'::regrole) THEN
    RAISE EXCEPTION 'jack_readonly is a member of another role; it must not be';
  END IF;
  IF to_regclass('public."SystemSetting"') IS NOT NULL
     AND has_table_privilege('jack_readonly', 'public."SystemSetting"', 'SELECT') THEN
    RAISE EXCEPTION 'jack_readonly can still read "SystemSetting" (check grants to PUBLIC)';
  END IF;
  FOREACH s IN ARRAY ARRAY['auth', 'storage', 'realtime', 'vault', 'jack_private'] LOOP
    IF to_regnamespace(s) IS NOT NULL AND has_schema_privilege('jack_readonly', s, 'USAGE') THEN
      RAISE EXCEPTION 'jack_readonly has USAGE on schema % (check grants to PUBLIC)', s;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND has_table_privilege('jack_readonly', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
  ) THEN
    RAISE EXCEPTION 'jack_readonly holds a table privilege other than SELECT in schema public';
  END IF;
END
$jack$;
