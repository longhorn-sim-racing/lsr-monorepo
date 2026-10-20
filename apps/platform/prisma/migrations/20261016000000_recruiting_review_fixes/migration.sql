-- Recruiting review fixes.

-- When a send was claimed (a first send or a manual resend), so a send that is still in flight
-- isn't mistaken for an interrupted one; and the idempotency key it was sent with, so a retry
-- after a crash reuses it and Resend can't deliver the same email twice.
ALTER TABLE "public"."ApplicationEmail" ADD COLUMN "claimedAt" TIMESTAMP(3);
ALTER TABLE "public"."ApplicationEmail" ADD COLUMN "idempotencyKey" TEXT;

-- Set once the deadline sweep has gone through a closed round without errors or running out of
-- time, so the cron stops re-scanning its abandoned drafts. Cleared when the deadline moves.
ALTER TABLE "public"."RecruitingCycle" ADD COLUMN "sweptAt" TIMESTAMP(3);

-- Hand-written (Prisma can't express these) -----------------------------------------

-- jack_readonly (the officer chat agent's read-only SQL role) gets SELECT on new tables through
-- default privileges, but these tables have row level security on, and with no policy for the
-- role it would see zero rows. Give it a read-only policy on each recruiting table. Only where
-- the role exists, like the revoke block in the previous migration.
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jack_readonly') THEN
    FOREACH t IN ARRAY ARRAY[
      'RecruitingCycle', 'Application', 'ApplicationTrack', 'ApplicationReview',
      'ApplicationEmail', 'RecruitingTrackConfig', 'RecruitingEmailTemplate'
    ] LOOP
      EXECUTE format('DROP POLICY IF EXISTS jack_readonly_select ON public.%I', t);
      EXECUTE format('CREATE POLICY jack_readonly_select ON public.%I FOR SELECT TO jack_readonly USING (true)', t);
    END LOOP;
  END IF;
END $$;
