/**
 * LOCAL ONLY: proves what Jack's database role can and can't do, connecting as jack_readonly through
 * JACK_DATABASE_URL (#161). Run scripts/jack-local-sql-role.ts first so the role can log in.
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/check-jack-sql-role.ts
 *
 * Checks, as jack_readonly:
 *   - SELECT on "Event" works
 *   - INSERT, UPDATE, DELETE and DDL fail, both in the default read-only session and with the
 *     session's read-only default turned off (so the grants, not just the read-only setting, stop them)
 *   - "SystemSetting", "_prisma_migrations", auth.users, storage.objects and jack_private are denied
 *   - a multi-statement query fails
 *   - set_config('role', 'postgres', true) and SET ROLE can't escalate
 *   - the 5s statement timeout stops pg_sleep(6), even after set_config tries to lift it
 *   - run_sql (the tool) rejects or maps each of these the way the model should see them
 *   - run_sql refuses catalog and settings access the role itself is allowed: every pg_ name but
 *     pg_typeof and pg_size_pretty (pg_settings, pg_db_role_setting, pg_roles, pg_user, pg_trigger,
 *     pg_proc, advisory locks, notifications, file reads, ending other sessions), current_setting and
 *     set_config, the XML exports that read a table or schema named in a string, ts_rewrite (a query
 *     in a string), large objects, dblink, and the net (pg_net), cron, vault and scheduler schemas,
 *     including after a -- comment ended by a carriage return. The check shows which of them the role
 *     itself could reach
 *   - run_sql drops session advisory locks after every query, failing ones included
 *   - Jack 2.0 (#188): pg_cron's cron schema and the scheduler are denied; every personal-data table
 *     has row level security on, Jack's read policy, and nothing for Supabase's anon/authenticated
 *     roles; the search index has row level security and no policy for Jack; the recruiting and audit
 *     log policies hide drafts and anything about an officer's own application (checked on the data
 *     when there is some, and on the policy text either way)
 *
 * Warns (doesn't fail) when the database keeps secret-looking settings in pg_db_role_setting, which any
 * role can read. Local Supabase does by design (its well-known local JWT secret in
 * app.settings.jwt_secret); production shouldn't. Only setting names are printed, never values.
 *
 * Refuses unless DATABASE_URL and JACK_DATABASE_URL point at 127.0.0.1 or localhost (no host or hostaddr
 * in the query string). Writes nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { localDatabaseProblem } from "../src/server/jack/eval-support";

for (const file of [".env.local", ".env"]) {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) continue;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
for (const name of ["DATABASE_URL", "JACK_DATABASE_URL"]) {
  const problem = localDatabaseProblem(name, process.env[name]);
  if (problem) {
    console.error(`Refusing to run: ${problem}${name === "JACK_DATABASE_URL" ? " Run scripts/jack-local-sql-role.ts first." : ""}`);
    process.exit(1);
  }
}

type Outcome = { ok: true; rows: unknown } | { ok: false; code: string; message: string };

const failures: string[] = [];
function report(pass: boolean, name: string, detail: string) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!pass) failures.push(name);
}

function errorOf(error: unknown): { code: string; message: string } {
  const e = error as { meta?: { code?: string; message?: string }; message?: string };
  return { code: e.meta?.code ?? "?", message: (e.meta?.message ?? e.message ?? String(error)).replace(/^ERROR:\s*/, "").split("\n")[0] };
}

async function main() {
  // One connection, so a session setting made by one call applies to the next. The tool's own client
  // (sql-client.ts) gets one connection too, so a setting changed on it is there for the tool's next query
  const url = process.env.JACK_DATABASE_URL!;
  const singleConnection = `${url}${url.includes("?") ? "&" : "?"}connection_limit=1`;
  process.env.JACK_DATABASE_URL = singleConnection;
  const jack = new PrismaClient({ datasourceUrl: singleConnection, log: [], errorFormat: "minimal" });
  const { runSqlTool } = await import("../src/server/jack/tools/run-sql");
  const { getJackSqlClient } = await import("../src/server/jack/sql-client");

  /**
   * Runs one statement as jack_readonly: in the session's default (read-only) mode, or after turning
   * the session's read-only default off, so only the grants stand in the way. (A session setting
   * rather than SET TRANSACTION READ WRITE, which Prisma's pgbouncer mode can't send first.)
   */
  async function attempt(sql: string, mode: "session" | "read-write" = "session"): Promise<Outcome> {
    try {
      if (mode === "session") return { ok: true, rows: await jack.$queryRawUnsafe(sql) };
      await jack.$executeRawUnsafe("SET default_transaction_read_only = off");
      return { ok: true, rows: await jack.$executeRawUnsafe(sql) };
    } catch (error) {
      return { ok: false, ...errorOf(error) };
    } finally {
      if (mode === "read-write") await jack.$executeRawUnsafe("RESET default_transaction_read_only").catch(() => {});
    }
  }

  function expectDenied(name: string, outcome: Outcome, codes: string[]) {
    if (outcome.ok) return report(false, name, "it worked");
    report(codes.includes(outcome.code), name, `${outcome.code}: ${outcome.message}`);
  }

  // Who we are, and the role's own settings
  const who = await attempt(
    `SELECT current_user::text AS "user", current_setting('default_transaction_read_only') AS ro, current_setting('statement_timeout') AS timeout,
            r.rolsuper AS super, r.rolcreaterole AS createrole, r.rolbypassrls AS bypassrls, r.rolconnlimit AS connlimit,
            (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS memberships
     FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const me = who.ok ? (who.rows as Record<string, unknown>[])[0] : null;
  report(me?.user === "jack_readonly", "connects as jack_readonly", JSON.stringify(me));
  report(me?.ro === "on" && me?.timeout === "5s", "sessions start read-only with a 5s statement timeout", `${me?.ro}, ${me?.timeout}`);
  report(me?.super === false && me?.createrole === false && me?.bypassrls === false && me?.memberships === 0, "no superuser, createrole, bypassrls or role memberships", "");

  // Reads
  const read = await attempt(`SELECT count(*)::int AS n FROM "Event"`);
  report(read.ok, 'SELECT on "Event" works', read.ok ? JSON.stringify(read.rows) : `${read.code}: ${read.message}`);

  // Writes: the read-only session stops them (25006); asking for READ WRITE, the grants still do (42501)
  const tag = `jack-check-${Date.now()}`;
  expectDenied("INSERT (read-only session)", await attempt(`INSERT INTO "Tag" (id, name, slug) VALUES ('${tag}', 'x', '${tag}')`), ["25006"]);
  expectDenied("INSERT (read-write session)", await attempt(`INSERT INTO "Tag" (id, name, slug) VALUES ('${tag}', 'x', '${tag}')`, "read-write"), ["42501"]);
  expectDenied("UPDATE (read-write session)", await attempt(`UPDATE "Event" SET title = title WHERE false`, "read-write"), ["42501"]);
  expectDenied("DELETE (read-write session)", await attempt(`DELETE FROM "Tag" WHERE false`, "read-write"), ["42501"]);
  expectDenied("TRUNCATE (read-write session)", await attempt(`TRUNCATE "Tag"`, "read-write"), ["42501"]);
  expectDenied("CREATE TABLE (read-only session)", await attempt(`CREATE TABLE public.jack_check (id int)`), ["25006"]);
  expectDenied("CREATE TABLE (read-write session)", await attempt(`CREATE TABLE public.jack_check (id int)`, "read-write"), ["42501"]);
  expectDenied("ALTER TABLE (read-write session)", await attempt(`ALTER TABLE "Event" ADD COLUMN jack_check int`, "read-write"), ["42501"]);
  expectDenied("DROP TABLE (read-write session)", await attempt(`DROP TABLE "Tag"`, "read-write"), ["42501"]);
  expectDenied("SELECT … FOR UPDATE (row locks)", await attempt(`SELECT id FROM "Event" LIMIT 1 FOR UPDATE`), ["25006", "42501"]);

  // Off-limits tables and schemas
  expectDenied('"SystemSetting" (secrets)', await attempt(`SELECT * FROM "SystemSetting"`), ["42501"]);
  expectDenied('"_prisma_migrations"', await attempt(`SELECT * FROM "_prisma_migrations"`), ["42501"]);
  expectDenied("auth.users", await attempt(`SELECT id FROM auth.users LIMIT 1`), ["42501"]);
  expectDenied("storage.objects", await attempt(`SELECT id FROM storage.objects LIMIT 1`), ["42501"]);
  expectDenied("jack_private.is_officer()", await attempt(`SELECT jack_private.is_officer() AS x`), ["42501"]);
  expectDenied("pg_authid (password hashes)", await attempt(`SELECT rolpassword FROM pg_authid LIMIT 1`), ["42501"]);
  expectDenied("pg_read_file", await attempt(`SELECT pg_read_file('postgresql.conf') AS f`), ["42501"]);

  // Jack 2.0 (#188): pg_cron and the scheduler are out of reach. (pg_net's `net` schema is granted to
  // PUBLIC on Supabase and can't be revoked; run_sql refuses its names instead, see run-sql.test.ts.)
  // A database without pg_cron answers "schema does not exist", which is denied too
  expectDenied("cron.job (pg_cron)", await attempt(`SELECT count(*)::int AS n FROM cron.job`), ["42501", "3F000", "42P01"]);
  expectDenied("scheduler.tick()", await attempt(`SELECT scheduler.tick() AS t`), ["42501", "3F000", "42883"]);

  // Jack 2.0 personal-data tables: RLS on, Jack's read policy there, Supabase's API roles shut out.
  // Read through the app's own connection, since the catalog query needs no special rights
  const app = new PrismaClient({ log: [], errorFormat: "minimal" });
  const personal = [
    "JackFile", "JackProposal", "EmailEvent", "ExternalDocument", "DiscordMessage", "DiscordMember", "TeamsMessage",
    "SponsorProspect", "SponsorActivity", "Meeting", "MeetingDecision", "ActionItem", "KnowledgeEntry", "KnowledgeEntryVersion",
  ];
  const rls = await app.$queryRawUnsafe<{ table: string; rls: boolean; policy: boolean; api: boolean }[]>(
    `SELECT c.relname AS "table", c.relrowsecurity AS rls,
            EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname AND p.policyname = 'jack_readonly_select') AS policy,
            EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated') AND has_table_privilege(r.oid, c.oid, 'SELECT')) AS api
     FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1)`,
    personal,
  );
  for (const table of personal) {
    const row = rls.find((r) => r.table === table);
    report(!!row && row.rls && row.policy && !row.api, `"${table}": row level security, Jack's read policy, no API-role access`, row ? `rls ${row.rls}, policy ${row.policy}, api ${row.api}` : "table missing");
  }
  const [searchDoc] = await app.$queryRawUnsafe<{ rls: boolean; policies: number }[]>(
    `SELECT c.relrowsecurity AS rls, (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'JackSearchDoc') AS policies
     FROM pg_class c WHERE c.oid = 'public."JackSearchDoc"'::regclass`,
  );
  report(!!searchDoc && searchDoc.rls && searchDoc.policies === 0, '"JackSearchDoc": row level security and no policy', JSON.stringify(searchDoc));
  expectDenied('"JackSearchDoc" (the search index; no grant)', await attempt(`SELECT count(*)::int AS n FROM "JackSearchDoc"`), ["42501"]);

  // Recruiting and the audit log (design §3.2): drafts, and anything about an officer's own
  // application, stay hidden. The policy text is checked always; the data only when there's some to
  // test against (this script writes nothing)
  const policies = await app.$queryRawUnsafe<{ table: string; qual: string }[]>(
    `SELECT tablename AS "table", qual FROM pg_policies WHERE schemaname = 'public' AND policyname = 'jack_readonly_select'
       AND tablename IN ('Application', 'ApplicationTrack', 'ApplicationReview', 'ApplicationEmail', 'AuditLog')`,
  );
  const qual = (table: string) => policies.find((p) => p.table === table)?.qual ?? "";
  report(qual("Application").includes("SUBMITTED"), "recruiting policy: only SUBMITTED applications", qual("Application").slice(0, 80));
  for (const table of ["ApplicationTrack", "ApplicationEmail", "AuditLog"]) {
    report(qual(table).includes("officer") && qual(table).includes("admin"), `${table} policy: hides officer and admin applicants`, qual(table).slice(0, 80));
  }
  report(qual("ApplicationReview").includes("ApplicationTrack"), "ApplicationReview policy: follows its team application", qual("ApplicationReview").slice(0, 80));

  async function hiddenOnData(name: string, sql: string) {
    const inDatabase = (await app.$queryRawUnsafe<{ n: number }[]>(sql))[0].n;
    if (inDatabase === 0) return console.log(`SKIP  ${name}  (nothing in the database to test against)`);
    const seen = await attempt(sql);
    report(seen.ok && (seen.rows as { n: number }[])[0].n === 0, name, `${inDatabase} in the database`);
  }
  const officerApplicant = `EXISTS (SELECT 1 FROM "UserRole" ur JOIN "Role" r ON r.id = ur."roleId" WHERE ur."userId" = a."userId" AND r.key IN ('officer', 'admin'))`;
  await hiddenOnData("recruiting: DRAFT applications are invisible", `SELECT count(*)::int AS n FROM "Application" WHERE state = 'DRAFT'`);
  await hiddenOnData(
    "recruiting: reviews of officers' applications are invisible",
    `SELECT count(*)::int AS n FROM "ApplicationReview" rv JOIN "ApplicationTrack" t ON t.id = rv."applicationTrackId" JOIN "Application" a ON a.id = t."applicationId" WHERE ${officerApplicant}`,
  );
  await hiddenOnData(
    "audit log: recruiting entries about officers' applications are invisible",
    `SELECT count(*)::int AS n FROM "AuditLog" l WHERE l."entityType" IN ('APPLICATION', 'APPLICATION_TRACK', 'APPLICATION_EMAIL')
       AND EXISTS (SELECT 1 FROM "UserRole" ur JOIN "Role" r ON r.id = ur."roleId" WHERE ur."userId" = l."targetUserId" AND r.key IN ('officer', 'admin'))`,
  );
  await app.$disconnect();

  // One statement at a time
  expectDenied("multi-statement query", await attempt(`SELECT 1 AS a; SELECT 2 AS b`), ["42601"]);

  // No way up to another role
  const escalate = await (async (): Promise<Outcome> => {
    try {
      const rows = await jack.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT set_config('role', 'postgres', true) AS r`);
        return tx.$queryRawUnsafe(`SELECT current_user::text AS u`);
      });
      return { ok: true, rows };
    } catch (error) {
      return { ok: false, ...errorOf(error) };
    }
  })();
  expectDenied("set_config('role', 'postgres', true)", escalate, ["42501"]);
  expectDenied("SET ROLE postgres", await attempt(`SET ROLE postgres`), ["42501"]);
  expectDenied("set_config('session_authorization', 'postgres', false)", await attempt(`SELECT set_config('session_authorization', 'postgres', false) AS s`), ["42501"]);

  // The timeout, from the role's settings and after trying to lift it mid-query
  let started = Date.now();
  const sleep = await attempt(`SELECT pg_sleep(6)::text AS s`);
  let seconds = (Date.now() - started) / 1000;
  report(!sleep.ok && sleep.code === "57014" && seconds < 6, "pg_sleep(6) is cancelled by the 5s timeout", sleep.ok ? "it finished" : `${sleep.code} after ${seconds.toFixed(1)}s`);
  started = Date.now();
  const lift = await attempt(`SELECT set_config('statement_timeout', '0', false) AS t, pg_sleep(6)::text AS s`);
  seconds = (Date.now() - started) / 1000;
  report(!lift.ok && lift.code === "57014" && seconds < 6, "lifting the timeout with set_config mid-query doesn't help", lift.ok ? "it finished" : `${lift.code} after ${seconds.toFixed(1)}s`);

  // What Postgres itself lets the role read in the catalog (every role can, by default). run_sql
  // refuses all of these below; this only shows what that refusal is standing in front of. Counts and
  // yes/no only, never the values
  const reachable: [string, string][] = [
    ["current_setting('app.settings.jwt_secret')", `SELECT (current_setting('app.settings.jwt_secret', true) IS NOT NULL) AS present`],
    ["pg_settings", `SELECT count(*)::int AS n FROM pg_settings`],
    ["pg_db_role_setting", `SELECT count(*)::int AS n FROM pg_db_role_setting`],
    ["pg_trigger.tgargs", `SELECT count(tgargs)::int AS n FROM pg_trigger`],
    ["pg_proc.prosrc", `SELECT count(prosrc)::int AS n FROM pg_proc`],
    ["pg_roles.rolconfig", `SELECT count(rolconfig)::int AS n FROM pg_roles`],
    ["table_to_xml('pg_db_role_setting')", `SELECT length(table_to_xml('pg_db_role_setting', true, false, '')::text) > 0 AS readable`],
  ];
  for (const [name, sql] of reachable) {
    const outcome = await attempt(sql);
    console.log(`INFO  as jack_readonly directly, ${name}: ${outcome.ok ? `readable ${JSON.stringify(outcome.rows)}` : `denied (${outcome.code})`}`);
  }

  // Secrets kept in database or role settings are readable by every role (pg_db_role_setting,
  // current_setting). Local Supabase keeps its well-known local JWT secret there by design; production
  // shouldn't keep anything there. Names only
  const settingNames = await attempt(`SELECT DISTINCT split_part(s, '=', 1) AS name FROM pg_db_role_setting, unnest(setconfig) AS s ORDER BY 1`);
  if (settingNames.ok) {
    const secretLooking = (settingNames.rows as { name: string }[]).map((r) => r.name).filter((name) => /secret|passw|token|jwt|key|credential/i.test(name));
    if (secretLooking.length) {
      console.log(
        `WARN  this database keeps secret-looking settings any role can read: ${secretLooking.join(", ")}. ` +
          "Expected on local Supabase (its local JWT secret); run_sql refuses current_setting and pg_db_role_setting, but don't keep secrets in database settings in production."
      );
    } else {
      console.log("INFO  no secret-looking settings in pg_db_role_setting");
    }
  } else {
    console.log(`INFO  couldn't list pg_db_role_setting (${settingNames.code}); nothing to warn about`);
  }
  await jack.$disconnect();

  // The tool itself
  const ctx = { roomId: "check", actor: { userId: null, displayName: "Role check" } };
  const tool = async (sql: string) => runSqlTool.run({ sql }, ctx);
  let r = await tool(`SELECT count(*) AS n FROM "Event";`);
  report(!r.isError && r.forModel.includes('"columns":["n"]'), "run_sql: a SELECT works (trailing ; stripped)", r.forModel.slice(0, 80));
  r = await tool(`DELETE FROM "Tag"`);
  report(!!r.isError && r.forModel.includes("must start with SELECT or WITH"), "run_sql: a DELETE is rejected before it runs", r.forModel.slice(0, 80));
  r = await tool(`WITH d AS (DELETE FROM "Tag" WHERE false RETURNING id) SELECT * FROM d`);
  report(!!r.isError, "run_sql: a data-modifying WITH fails in the database", r.forModel.slice(0, 120));
  r = await tool(`SELECT 1 AS a; SELECT 2 AS b`);
  report(!!r.isError, "run_sql: two statements fail", r.forModel.slice(0, 120));
  r = await tool(`SELECT * FROM "SystemSetting"`);
  report(!!r.isError && r.forModel.startsWith("Permission denied") && r.forModel.includes("off-limits"), "run_sql: SystemSetting reads as off-limits", r.forModel.slice(0, 80));
  r = await tool(`SELECT generate_series(1, 500) AS n`);
  report(!r.isError && r.forModel.includes('"rowCount":200') && r.forModel.includes('"truncated":true'), "run_sql: 500 rows come back capped at 200 and flagged", r.label);

  // Catalog and settings access, refused before it reaches the database
  const offLimits: [string, string][] = [
    ["current_setting (the JWT secret)", `SELECT current_setting('app.settings.jwt_secret', true) AS s`],
    ["set_config", `SELECT set_config('statement_timeout', '0', false) AS s`],
    ["pg_settings", `SELECT name, setting FROM pg_settings`],
    ['pg_catalog."pg_settings" (quoted)', `SELECT name, setting FROM pg_catalog."pg_settings"`],
    ["pg_db_role_setting", `SELECT setconfig FROM pg_db_role_setting`],
    ["pg_file_settings", `SELECT * FROM pg_file_settings`],
    ["pg_roles.rolconfig", `SELECT rolname, rolconfig FROM pg_roles`],
    ["pg_trigger.tgargs", `SELECT tgname, tgargs FROM pg_trigger`],
    ["pg_proc.prosrc", `SELECT proname, prosrc FROM pg_proc`],
    ["pg_advisory_lock", `SELECT pg_advisory_lock(42)::text AS l`],
    ["pg_try_advisory_lock", `SELECT pg_try_advisory_lock(42) AS l`],
    ["pg_notify", `SELECT pg_notify('jack', 'hi')::text AS n`],
    ["pg_read_file", `SELECT pg_read_file('postgresql.conf') AS f`],
    ["pg_ls_dir", `SELECT * FROM pg_ls_dir('.') AS f`],
    ["pg_stat_file", `SELECT * FROM pg_stat_file('postgresql.conf')`],
    ["lo_import", `SELECT lo_import('/etc/passwd')::text AS o`],
    ["dblink", `SELECT * FROM dblink('dbname=postgres', 'select 1') AS t(a int)`],
    ["pg_terminate_backend", `SELECT pg_terminate_backend(pg_backend_pid()) AS t`],
    ["pg_cancel_backend", `SELECT pg_cancel_backend(1) AS t`],
    ["query_to_xml (a query hidden in a string)", `SELECT query_to_xml('select current_setting(''app.settings.jwt_secret'', true)', true, true, '')::text AS x`],
    ["table_to_xml (a catalog table named in a string)", `SELECT table_to_xml('pg_db_role_setting', true, false, '')::text AS x`],
    ["schema_to_xml (the whole catalog)", `SELECT schema_to_xml('pg_catalog', true, false, '')::text AS x`],
    ["database_to_xml", `SELECT database_to_xml(true, false, '')::text AS x`],
    ["pg_roles (rolconfig)", `SELECT * FROM pg_roles`],
    ["row_to_json over pg_user (useconfig)", `SELECT row_to_json(u)::text AS r FROM pg_user u`],
    ["pg_sleep (any pg_ function)", `SELECT pg_sleep(0)::text AS s`],
    ["a -- comment ended by a carriage return", `SELECT 1 AS a -- note\r, length(current_setting('app.settings.jwt_secret', true)) AS secret_len`],
    ["net.http_get (outbound HTTP)", `SELECT net.http_get('https://example.com') AS id`],
    ["net._http_response (pg_net's stored responses)", `SELECT count(*) AS n FROM net._http_response`],
    ["cron.job", `SELECT count(*) AS n FROM cron.job`],
    ["vault.decrypted_secrets", `SELECT count(*) AS n FROM vault.decrypted_secrets`],
    ["scheduler.tick", `SELECT scheduler.tick()::text AS t`],
    ["ts_rewrite (a query hidden in a string)", `SELECT ts_rewrite('a'::tsquery, 'SELECT ''a''::tsquery, quote_literal(left(content, 200))::tsquery FROM net._http_response')::text AS t`],
  ];
  for (const [name, sql] of offLimits) {
    r = await tool(sql);
    report(!!r.isError && r.forModel.startsWith("Catalog and settings access is off-limits"), `run_sql refuses ${name}`, r.isError ? "" : `it ran: ${r.label}`);
  }
  r = await tool(`SELECT 'current_setting' AS s -- pg_settings`);
  report(!r.isError, "run_sql: off-limits names inside strings and comments don't count", r.forModel.slice(0, 80));
  r = await tool(`SELECT pg_typeof(1)::text AS t, pg_size_pretty(1024::bigint) AS s, 1 AS notify, 2 AS lo_count, 3 AS net, 4 AS cron`);
  report(!r.isError, "run_sql: pg_typeof, pg_size_pretty and harmless aliases (net and cron included) still work", r.forModel.slice(0, 80));

  // A setting changed on the tool's pooled connection (outside run_sql, which refuses set_config)
  // doesn't carry into run_sql's next query: each gets its own 5s, read-only transaction
  const pool = getJackSqlClient()!;

  // A session advisory lock on the tool's connection (taken outside run_sql, which refuses them) is
  // gone after run_sql's next query, whether it worked or failed
  const advisoryHeld = async () =>
    (await pool.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`))[0].n;
  await pool.$queryRawUnsafe(`SELECT pg_advisory_lock(4242)::text AS l`);
  const heldBefore = await advisoryHeld();
  r = await tool(`SELECT nope FROM "Event"`);
  let heldAfter = await advisoryHeld();
  report(
    heldBefore === 1 && heldAfter === 0 && !!r.isError && r.forModel.startsWith("Postgres error 42703"),
    "run_sql: a failing query still drops session advisory locks (and reports its own error)",
    `${heldBefore} held before, ${heldAfter} after; ${r.forModel.slice(0, 60)}`
  );
  await pool.$queryRawUnsafe(`SELECT pg_advisory_lock(4242)::text AS l`);
  r = await tool(`SELECT count(*) AS n FROM "Event"`);
  heldAfter = await advisoryHeld();
  report(!r.isError && heldAfter === 0, "run_sql: a query that works drops them too", `${heldAfter} held after`);

  await pool.$queryRawUnsafe(`SELECT set_config('statement_timeout', '0', false) AS t`);
  await pool.$executeRawUnsafe("SET default_transaction_read_only = off");
  started = Date.now();
  // A long query that names nothing off-limits: about 10^10 rows to count
  r = await tool(`SELECT count(*) AS n FROM generate_series(1, 100000) AS a, generate_series(1, 100000) AS b`);
  seconds = (Date.now() - started) / 1000;
  report(!!r.isError && r.forModel.includes("longer than 5s") && seconds < 7, "run_sql: the 5s timeout holds after the session's was lifted", `${seconds.toFixed(1)}s: ${r.forModel.slice(0, 60)}`);
  r = await tool(`SELECT id FROM "Event" LIMIT 1 FOR UPDATE`);
  report(!!r.isError && r.forModel.includes("read-only transaction"), "run_sql: read-only holds after the session's default was turned off", r.forModel.slice(0, 80));
  await pool.$disconnect();

  console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join("; ")}` : "\nAll checks passed.");
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
