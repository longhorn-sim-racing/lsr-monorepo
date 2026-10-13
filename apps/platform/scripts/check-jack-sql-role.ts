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
 *
 * Refuses unless DATABASE_URL and JACK_DATABASE_URL point at 127.0.0.1 or localhost. Writes nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

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
  let host = "";
  try {
    host = new URL(process.env[name] ?? "").hostname;
  } catch {}
  if (!["127.0.0.1", "localhost"].includes(host)) {
    console.error(`Refusing to run: ${name} points at "${host || "nothing"}", not the local database.${name === "JACK_DATABASE_URL" ? " Run scripts/jack-local-sql-role.ts first." : ""}`);
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
  // One connection, so a session setting made by one call applies to the next
  const url = process.env.JACK_DATABASE_URL!;
  const jack = new PrismaClient({ datasourceUrl: `${url}${url.includes("?") ? "&" : "?"}connection_limit=1`, log: [], errorFormat: "minimal" });
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
  r = await tool(`SELECT set_config('statement_timeout', '0', false) AS t`);
  r = await tool(`SELECT current_setting('statement_timeout') AS t, current_setting('transaction_read_only') AS ro`);
  report(r.forModel.includes('["5s","on"]'), "run_sql: each query gets its own 5s, read-only transaction even after set_config", r.forModel.slice(-30));
  await getJackSqlClient()?.$disconnect();

  console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join("; ")}` : "\nAll checks passed.");
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
