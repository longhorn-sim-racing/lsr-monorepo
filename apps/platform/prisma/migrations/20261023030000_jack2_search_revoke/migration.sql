-- ---------------------------------------------------------------------------
-- Jack 2.0: Jack's SQL role can't read the search index (#188; design §3.1).
--
-- "JackSearchDoc" holds the lexemes of everything searchable (room messages, knowledge, documents,
-- Teams messages). Search goes through the typed tools, which use the app's connection. Without a
-- grant, run_sql gets "permission denied" and tells Jack the table is off-limits, the same way it does
-- for "SystemSetting" (row level security alone would answer with zero rows, and Prisma can't read a
-- tsvector column anyway).
--
-- Only removes a privilege from jack_readonly; safe to apply before the app deploys.
-- ---------------------------------------------------------------------------
DO $revoke$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jack_readonly') THEN
    RAISE NOTICE 'jack_readonly does not exist; nothing to revoke';
    RETURN;
  END IF;
  REVOKE ALL ON TABLE public."JackSearchDoc" FROM jack_readonly;
  IF has_table_privilege('jack_readonly', 'public."JackSearchDoc"', 'SELECT') THEN
    RAISE EXCEPTION 'jack_readonly can still read "JackSearchDoc" (check grants to PUBLIC)';
  END IF;
END
$revoke$;
