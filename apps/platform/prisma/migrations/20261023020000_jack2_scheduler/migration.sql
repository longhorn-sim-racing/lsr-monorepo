-- ---------------------------------------------------------------------------
-- Jack 2.0 scheduler (#188; design §6; research: docs/jack-2/research/supabase-pg-cron.md).
--
-- pg_cron runs scheduler.tick() every minute (that schedule is a setup step, not a migration: see
-- scripts/jack-scheduler-setup.ts). tick() does nothing unless a ScheduledJob row is due; when one is,
-- it POSTs to the site's /api/cron/tick through pg_net, signed with an HMAC. It never sends the secret
-- itself: pg_net's request queue is readable by every database role (Supabase grants it to PUBLIC
-- and that can't be revoked), Jack's read-only role included.
--
-- The secret and the site URL live in Supabase Vault (lsr_scheduler_secret, lsr_scheduler_url), set by
-- hand, never in git. This migration holds no secrets.
--
-- The extensions are only created on a Supabase database that has them, and only in the database
-- pg_cron runs in: Prisma's shadow database and local copies (lsr_eval) skip that part. In production,
-- enable pg_cron and pg_net in the Supabase dashboard first (release plan); then CREATE EXTENSION
-- below does nothing.
-- ---------------------------------------------------------------------------

DO $sched$
BEGIN
  IF current_database() <> coalesce(current_setting('cron.database_name', true), 'postgres')
     OR to_regnamespace('extensions') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron')
     OR NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_net') THEN
    RAISE NOTICE 'Not a Supabase database with pg_cron and pg_net available; skipping the scheduler extensions';
    RETURN;
  END IF;
  CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
  CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
END
$sched$;

CREATE SCHEMA IF NOT EXISTS scheduler;
REVOKE ALL ON SCHEMA scheduler FROM PUBLIC;

-- Called by pg_cron every minute. Returns the pg_net request id, or NULL when nothing was due (or the
-- Vault values aren't set). The signature is v1=hex(HMAC_SHA256(secret, timestamp + "." + body)),
-- over the exact body text pg_net sends; /api/cron/tick verifies it against the raw request body.
CREATE OR REPLACE FUNCTION scheduler.tick() RETURNS bigint LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_url text;
  v_secret text;
  v_ts text;
  v_body jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public."ScheduledJob"
    WHERE enabled AND "nextRunAt" <= now() AND ("lockedUntil" IS NULL OR "lockedUntil" < now())
  ) THEN
    RETURN NULL;
  END IF;
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'lsr_scheduler_url';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'lsr_scheduler_secret';
  IF v_url IS NULL OR v_secret IS NULL THEN
    RAISE NOTICE 'scheduler: Vault values lsr_scheduler_url / lsr_scheduler_secret are not set';
    RETURN NULL;
  END IF;
  v_ts := floor(extract(epoch FROM now()))::bigint::text;
  v_body := jsonb_build_object('kind', 'tick', 'ts', v_ts::bigint, 'nonce', gen_random_uuid());
  RETURN net.http_post(
    url := v_url,
    body := v_body,
    timeout_milliseconds := 10000,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-LSR-Timestamp', v_ts,
      'X-LSR-Signature', 'v1=' || encode(extensions.hmac(v_ts || '.' || v_body::text, v_secret, 'sha256'), 'hex')
    )
  );
END
$$;

REVOKE EXECUTE ON FUNCTION scheduler.tick() FROM PUBLIC;

-- Checks: Jack's SQL role can't reach the scheduler or pg_cron. (Not `net`: Supabase grants its
-- schema to PUBLIC and that can't be revoked; run_sql refuses its names instead.)
DO $chk$
DECLARE
  s text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jack_readonly') THEN
    RETURN;
  END IF;
  FOREACH s IN ARRAY ARRAY['cron', 'scheduler'] LOOP
    IF to_regnamespace(s) IS NOT NULL AND has_schema_privilege('jack_readonly', s, 'USAGE') THEN
      RAISE EXCEPTION 'jack_readonly has USAGE on schema % (check grants to PUBLIC)', s;
    END IF;
  END LOOP;
END
$chk$;
