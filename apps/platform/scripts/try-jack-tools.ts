/**
 * LOCAL ONLY: runs each of Jack's tools once against the local database and prints what the model
 * would read back, so you can eyeball the outputs (#161). Also checks every tool's input converts to
 * JSON Schema, the way the model loop sends it.
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/try-jack-tools.ts            # every tool, outputs cut short
 *   pnpm --filter @lsr/platform exec tsx scripts/try-jack-tools.ts --full     # whole outputs
 *   pnpm --filter @lsr/platform exec tsx scripts/try-jack-tools.ts --draft    # also drafts (then deletes) an event
 *
 * Refuses unless DATABASE_URL and JACK_DATABASE_URL point at 127.0.0.1 or localhost.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

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
    console.error(`Refusing to run: ${name} points at "${host || "nothing"}", not the local database.`);
    process.exit(1);
  }
}

const full = process.argv.includes("--full");
const draft = process.argv.includes("--draft");

async function main() {
  const { JACK_TOOLS, findJackTool } = await import("../src/server/jack/tools");
  const { prisma } = await import("../src/server/db");
  const { getJackSqlClient } = await import("../src/server/jack/sql-client");
  const admin = await prisma.user.findFirst({ where: { roles: { some: { role: { key: { in: ["admin", "officer"] } } } } } });
  const ctx = { roomId: "local-try", actor: { userId: admin?.id ?? null, displayName: admin?.displayName ?? "Local check" } };

  for (const tool of JACK_TOOLS) {
    const schema = JSON.stringify(z.toJSONSchema(tool.input));
    console.log(`schema ${tool.name}: ${schema.length} chars`);
  }

  const calls: [string, unknown][] = [
    ["club_members", {}],
    ["club_members", { groupBy: "week", newest: 3 }],
    ["events_overview", {}],
    ["events_overview", { search: "round 4" }],
    ["lsc_entries", {}],
    ["payments_summary", { from: "2026-01-01", list: true }],
    ["standings", {}],
    ["audit_log", { from: "2026-01-01" }],
    ["describe_schema", { tables: ["Payment", "Entitlement"] }],
    ["run_sql", { sql: 'SELECT status, count(*) AS n FROM "Event" GROUP BY status', purpose: "Events by status" }],
    ["run_sql", { sql: 'SELECT * FROM "SystemSetting"' }],
    ["chart", { type: "bar", title: "Signups by month", xKey: "month", series: [{ key: "n", label: "Signups" }], rows: [{ month: "2026-09", n: 3 }, { month: "2026-10", n: "1" }] }],
    ["chart", { type: "pie", title: "Bad", xKey: "k", series: [{ key: "a", label: "A" }, { key: "b", label: "B" }], rows: [{ k: "x", a: 1, b: 2 }] }],
  ];
  if (draft) {
    calls.push(["draft_event", { title: "Jack local check event", startsAt: "2026-11-02T18:00", endsAt: "2026-11-02T20:00", summary: "Drafted by scripts/try-jack-tools.ts" }]);
    calls.push(["draft_event", { title: "Bad times", startsAt: "2026-11-02T20:00", endsAt: "2026-11-02T18:00" }]);
    calls.push(["draft_event", { title: "Bad venue", startsAt: "2026-11-02T18:00", endsAt: "2026-11-02T20:00", venue: "Nowhere Hall" }]);
  }

  for (const [name, raw] of calls) {
    const tool = findJackTool(name)!;
    const parsed = tool.input.safeParse(raw);
    if (!parsed.success) {
      console.log(`\n=== ${name}: INPUT REJECTED: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
      continue;
    }
    const started = Date.now();
    const result = await tool.run(parsed.data, ctx);
    const out = full ? result.forModel : result.forModel.slice(0, 900) + (result.forModel.length > 900 ? ` … (${result.forModel.length} chars)` : "");
    console.log(`\n=== ${name} (${Date.now() - started} ms)${result.isError ? " ERROR" : ""}: ${result.label}`);
    console.log(out);
    console.log(`displays: ${(result.displays ?? []).map((d) => d.kind + (d.kind === "table" ? `(${d.rows.length}x${d.columns.length})` : "")).join(", ") || "none"}`);
    if (name === "draft_event" && !result.isError) {
      const id = (JSON.parse(result.forModel) as { eventId: string }).eventId;
      const audit = await prisma.auditLog.findFirst({ where: { entityId: id }, select: { actorUserId: true, summary: true } });
      const event = await prisma.event.findUnique({ where: { id }, select: { status: true, publishedAt: true } });
      console.log(`event ${JSON.stringify(event)}; audit ${JSON.stringify(audit)}`);
      await prisma.auditLog.deleteMany({ where: { entityId: id } });
      await prisma.event.delete({ where: { id } });
      console.log("(deleted the check event and its audit entry)");
    }
  }

  await prisma.$disconnect();
  await getJackSqlClient()?.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
