-- ---------------------------------------------------------------------------
-- Jack 2.0: recruiting privacy for Jack's SQL role (#188; design §3.2).
--
-- The recruiting migration gave jack_readonly `USING (true)` on every recruiting table. Jack's rooms
-- are shared by every officer, so what Jack can read, every officer can read. These policies make the
-- database enforce what the admin pages already do:
--   - DRAFT applications are invisible (the app hides them from officers too).
--   - Teams, reviews, scores, decisions and decision emails on an application from someone who holds
--     the officer or admin role are invisible, so an officer can never read their own (or a fellow
--     officer's) reviews through Jack.
-- The recruiting tool applies the same rules in code; this covers raw SQL (run_sql).
--
-- Only touches jack_readonly's policies; the app connects as the table owner, which RLS doesn't
-- restrict. Safe to apply before the app deploys.
-- ---------------------------------------------------------------------------
DO $recruit$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jack_readonly') THEN
    RAISE NOTICE 'jack_readonly does not exist; skipping its recruiting policies';
    RETURN;
  END IF;

  DROP POLICY IF EXISTS jack_readonly_select ON public."Application";
  CREATE POLICY jack_readonly_select ON public."Application" FOR SELECT TO jack_readonly
    USING (state = 'SUBMITTED');

  -- A team application is visible when its application is (submitted) and the applicant isn't an
  -- officer or admin. The Application subquery runs under Application's own policy
  DROP POLICY IF EXISTS jack_readonly_select ON public."ApplicationTrack";
  CREATE POLICY jack_readonly_select ON public."ApplicationTrack" FOR SELECT TO jack_readonly
    USING (EXISTS (
      SELECT 1 FROM public."Application" a
      WHERE a.id = "ApplicationTrack"."applicationId"
        AND NOT EXISTS (
          SELECT 1 FROM public."UserRole" ur JOIN public."Role" r ON r.id = ur."roleId"
          WHERE ur."userId" = a."userId" AND r.key IN ('officer', 'admin')
        )
    ));

  -- Reviews follow their team application (the subquery runs under ApplicationTrack's policy)
  DROP POLICY IF EXISTS jack_readonly_select ON public."ApplicationReview";
  CREATE POLICY jack_readonly_select ON public."ApplicationReview" FOR SELECT TO jack_readonly
    USING (EXISTS (SELECT 1 FROM public."ApplicationTrack" t WHERE t.id = "ApplicationReview"."applicationTrackId"));

  -- Decision and confirmation emails follow the same rule as team applications
  DROP POLICY IF EXISTS jack_readonly_select ON public."ApplicationEmail";
  CREATE POLICY jack_readonly_select ON public."ApplicationEmail" FOR SELECT TO jack_readonly
    USING (EXISTS (
      SELECT 1 FROM public."Application" a
      WHERE a.id = "ApplicationEmail"."applicationId"
        AND NOT EXISTS (
          SELECT 1 FROM public."UserRole" ur JOIN public."Role" r ON r.id = ur."roleId"
          WHERE ur."userId" = a."userId" AND r.key IN ('officer', 'admin')
        )
    ));
  -- RecruitingCycle and RecruitingTrackConfig keep USING (true): rounds and booking links
END
$recruit$;
