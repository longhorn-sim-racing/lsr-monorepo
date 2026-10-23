-- Jack 2.0 (discord-read, security fix): who started a Discord thread, so a purge on request can remove
-- the titles of threads and forum posts a member started, and the sync can keep them untitled after
-- (design §12.1 "Deletion on request"). Additive: one nullable column that older code never reads, safe
-- to apply before the app deploys.
--
-- DiscordChannel now holds personal data: a thread's name is a member's title, and ownerId says whose.
-- This supersedes the note in 20261023070000_jack2_discord_thread_parent ("no personal data, so no RLS
-- change"): the table gets row level security and Jack's read policy like the other personal-data
-- tables (20261023000000_jack2_core, part 3). The app connects as the table owner, which RLS doesn't
-- restrict; anon and authenticated lose access (production revokes schema public from them anyway).

-- AlterTable
ALTER TABLE "public"."DiscordChannel" ADD COLUMN     "ownerId" TEXT;

ALTER TABLE public."DiscordChannel" ENABLE ROW LEVEL SECURITY;

DO $rls$
DECLARE
  r text;
BEGIN
  -- Supabase's API roles get nothing on it (they don't exist on plain Postgres)
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', 'DiscordChannel', r);
    END IF;
  END LOOP;

  -- jack_readonly reads it through a policy (without one it would see zero rows)
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jack_readonly') THEN
    DROP POLICY IF EXISTS jack_readonly_select ON public."DiscordChannel";
    CREATE POLICY jack_readonly_select ON public."DiscordChannel" FOR SELECT TO jack_readonly USING (true);
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public."DiscordChannel"'::regclass) THEN
    RAISE EXCEPTION 'row level security is off on DiscordChannel';
  END IF;
END
$rls$;
