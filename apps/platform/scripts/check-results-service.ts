/**
 * Golden check for src/server/services/results.service.ts (Jack 2.0, design §4.4), against the LOCAL
 * Supabase only:
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/check-results-service.ts [--upload <id>]... [--limit <n>] [--verbose]
 *
 * It replays real uploads through the service and diffs the race records against the ones already
 * ingested:
 * 1. Reads INGESTED uploads from the eval copy of production (LSR_EVAL_DATABASE_URL, default `lsr_eval`
 *    on the local Supabase). READ ONLY: every read runs in a read-only transaction.
 * 2. Creates a throwaway database on the same server and applies the migrations (prisma migrate deploy).
 *    For each upload it adds stand-ins for what the upload needs: the event, the members its drivers are
 *    linked to (ids only, no names or emails), their DriverIdentity rows and the CarMapping rows.
 * 3. Runs the upload through createUpload, parseUpload({ write: false }) (which must write nothing and
 *    agree with the writing parse), parseUpload({ write: true }), bindUpload (with the stored event,
 *    points and session label) and ingestUpload.
 * 4. Compares the RaceSession, RaceParticipant, RaceResult, RaceLap and RaceEvent rows, plus the
 *    ParseReport, with the eval copy's. Ids and timestamps are ignored; participants are matched by
 *    driver GUID. Prints a line per upload and a summary of the fields that differ (values only with
 *    --verbose, since they're member data).
 * 5. Drops the throwaway database, pass or fail.
 *
 * Exits 1 when anything differs or fails. Differences can come from code changes since an upload was
 * first ingested, not only from this refactor: read the field summary before blaming the service.
 * Never writes to the eval copy and never saves its data anywhere: it's real member data.
 * Refuses unless the eval URL points at 127.0.0.1 or localhost.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { PrismaClient, type Prisma } from "@prisma/client";
import { localDatabaseProblem } from "../src/server/jack/eval-support";
import type { AcResultFile } from "../src/lib/results/ac-result-file";

// ---------------------------------------------------------------------------
// arguments and guards
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const ONLY: string[] = [];
let LIMIT: number | undefined;
let VERBOSE = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--upload") ONLY.push(args[++i]);
  else if (args[i] === "--limit") LIMIT = Number(args[++i]);
  else if (args[i] === "--verbose") VERBOSE = true;
  else {
    console.error(`Unknown argument ${args[i]}. Use --upload <id> (repeatable), --limit <n>, --verbose.`);
    process.exit(1);
  }
}
if (LIMIT !== undefined && !(Number.isInteger(LIMIT) && LIMIT > 0)) {
  console.error("--limit takes a whole number above 0.");
  process.exit(1);
}

const EVAL_URL = process.env.LSR_EVAL_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/lsr_eval";
const problem = localDatabaseProblem("LSR_EVAL_DATABASE_URL", EVAL_URL);
if (problem) {
  console.error(`Refusing to run: ${problem}`);
  process.exit(1);
}

function withDatabase(url: string, database: string) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const THROWAWAY = `lsr_check_results_${randomBytes(4).toString("hex")}`;
const THROWAWAY_URL = withDatabase(EVAL_URL, THROWAWAY);
const evalName = decodeURIComponent(new URL(EVAL_URL).pathname.slice(1));

// db.ts logs every query unless NODE_ENV is production; keep the run readable.
(process.env as Record<string, string | undefined>).NODE_ENV ??= "production";

const evalDb = new PrismaClient({ datasourceUrl: EVAL_URL });
const adminDb = new PrismaClient({ datasourceUrl: withDatabase(EVAL_URL, "postgres") });

/** Every read of the eval copy runs in a read-only transaction, so nothing here can write to it */
function readEval<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return evalDb.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return fn(tx);
    },
    { maxWait: 30_000, timeout: 120_000 },
  );
}

// ---------------------------------------------------------------------------
// normalizing race records
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
type SessionRows = {
  eventId: string | null;
  sessionType: string;
  trackName: string;
  trackConfig: string | null;
  startedAt: Date;
  pointsSystem: string | null;
  participants: Row[];
  results: Row[];
  laps: Row[];
  events: Row[];
};
type Normalized = Record<"RaceSession" | "RaceParticipant" | "RaceResult" | "RaceLap" | "RaceEvent", Map<string, Row>>;

const DROP = new Set(["id", "sessionId", "uploadId", "createdAt", "updatedAt"]);

function plain(row: Row, guidOf: Map<string, string>): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (DROP.has(key)) continue;
    if (key === "participantId" || key === "otherParticipantId") {
      out[key.replace("Id", "")] = value == null ? null : (guidOf.get(value as string) ?? "?");
      continue;
    }
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

/** Rows keyed so the two sides line up: participants by GUID, results by position, laps by GUID and lap */
function normalize(session: SessionRows, ignoreStartedAt: boolean): Normalized {
  const guidOf = new Map(session.participants.map((p) => [p.id as string, p.driverGuid as string]));
  const sessionRow: Row = {
    eventId: session.eventId,
    sessionType: session.sessionType,
    trackName: session.trackName,
    trackConfig: session.trackConfig,
    pointsSystem: session.pointsSystem,
    ...(ignoreStartedAt ? {} : { startedAt: session.startedAt.toISOString() }),
  };
  const keyed = (rows: Row[], key: (row: Row) => string) => {
    const map = new Map<string, Row>();
    for (const row of rows) {
      const p = plain(row, guidOf);
      let k = key(p);
      // Duplicates (two identical collisions, say) get their own keys
      for (let n = 2; map.has(k); n++) k = `${key(p)}~${n}`;
      map.set(k, p);
    }
    return map;
  };
  return {
    RaceSession: new Map([["session", sessionRow]]),
    RaceParticipant: keyed(session.participants, (p) => String(p.driverGuid)),
    RaceResult: keyed(session.results, (r) => `P${r.position}`),
    RaceLap: keyed(session.laps, (l) => `${l.participant}#${l.lapNumber}`),
    RaceEvent: keyed(session.events, (e) => JSON.stringify(e)),
  };
}

type Difference = { table: string; field: string; key: string; expected: unknown; actual: unknown };

function compare(expected: Normalized, actual: Normalized): Difference[] {
  const differences: Difference[] = [];
  for (const table of Object.keys(expected) as (keyof Normalized)[]) {
    const left = expected[table];
    const right = actual[table];
    for (const [key, row] of left) {
      const other = right.get(key);
      if (!other) {
        differences.push({ table, field: "(row missing)", key, expected: row, actual: undefined });
        continue;
      }
      for (const field of new Set([...Object.keys(row), ...Object.keys(other)])) {
        if (JSON.stringify(row[field]) !== JSON.stringify(other[field])) {
          differences.push({ table, field, key, expected: row[field], actual: other[field] });
        }
      }
    }
    for (const [key, row] of right) {
      if (!left.has(key)) differences.push({ table, field: "(extra row)", key, expected: undefined, actual: row });
    }
  }
  return differences;
}

// ---------------------------------------------------------------------------
// the replay
// ---------------------------------------------------------------------------
const raceInclude = { participants: true, results: true, laps: true, events: true } as const;

/** Every GUID the parse and ingest look up: the cars' drivers and the result rows */
function guidsIn(file: AcResultFile) {
  const guids = new Set<string>();
  for (const car of Array.isArray(file.Cars) ? file.Cars : []) if (car.Driver?.Guid) guids.add(car.Driver.Guid);
  for (const row of Array.isArray(file.Result) ? file.Result : []) if (row.DriverGuid) guids.add(row.DriverGuid);
  return [...guids];
}

function carModelsIn(file: AcResultFile) {
  return [...new Set((Array.isArray(file.Cars) ? file.Cars : []).map((car) => car.Model).filter(Boolean))];
}

type Outcome = { status: "match" | "differ" | "failed"; differences: Difference[]; note?: string };

async function main() {
  const uploads = await readEval((tx) =>
    tx.rawResultUpload.findMany({
      where: { status: "INGESTED", ...(ONLY.length ? { id: { in: ONLY } } : {}) },
      select: { id: true, filename: true },
      orderBy: { uploadedAt: "asc" },
      take: LIMIT,
    }),
  );
  if (uploads.length === 0) {
    console.log(`No INGESTED uploads in ${evalName}${ONLY.length ? " with those ids" : ""}. Nothing to check.`);
    return 0;
  }

  console.log(`Replaying ${uploads.length} ingested upload(s) from ${evalName} into a throwaway database (${THROWAWAY}).`);
  await adminDb.$executeRawUnsafe(`CREATE DATABASE "${THROWAWAY}"`);
  let replayDb: PrismaClient | undefined;
  try {
    const app = resolve(__dirname, "..");
    execFileSync(process.execPath, [resolve(app, "node_modules/prisma/build/index.js"), "migrate", "deploy", "--schema", resolve(app, "prisma/schema.prisma")], {
      cwd: app,
      env: { ...process.env, DATABASE_URL: THROWAWAY_URL, DIRECT_URL: THROWAWAY_URL },
      stdio: "pipe",
    });

    // The service uses the shared client from db.ts, which reads DATABASE_URL when first imported
    process.env.DATABASE_URL = THROWAWAY_URL;
    const { prisma } = await import("../src/server/db");
    replayDb = prisma;
    const results = await import("../src/server/services/results.service");

    const checker = await prisma.user.create({
      data: { email: "checker@check.invalid", handle: "results-checker", displayName: "Results check" },
    });
    const actor = { userId: checker.id };

    const ensureUser = (id: string) =>
      prisma.user.upsert({
        where: { id },
        create: { id, email: `${id}@check.invalid`, handle: `member-${id}`, displayName: "Member" },
        update: {},
      });

    async function replay(uploadId: string): Promise<Outcome> {
      const original = await readEval((tx) =>
        tx.rawResultUpload.findUniqueOrThrow({
          where: { id: uploadId },
          include: { parseReport: true, ingestedSessions: { include: raceInclude } },
        }),
      );
      if (!original.eventId) return { status: "failed", differences: [], note: "ingested but has no event link" };
      if (original.ingestedSessions.length === 0) return { status: "failed", differences: [], note: "marked INGESTED but has no race session" };
      const file = original.rawJson as AcResultFile;
      const guids = guidsIn(file);
      const [identities, mappings] = await readEval(async (tx) => [
        await tx.driverIdentity.findMany({ where: { driverGuid: { in: guids } } }),
        await tx.carMapping.findMany({ where: { gameCarName: { in: carModelsIn(file) } } }),
      ] as const);

      // Stand-ins for what the upload needs
      await prisma.event.upsert({
        where: { id: original.eventId },
        create: { id: original.eventId, slug: `event-${original.eventId}`, title: "Event", startsAtUtc: new Date(), endsAtUtc: new Date(), timezone: "America/Chicago" },
        update: {},
      });
      for (const identity of identities) {
        if (identity.userId) await ensureUser(identity.userId);
        await prisma.driverIdentity.upsert({
          where: { driverGuid: identity.driverGuid },
          create: { driverGuid: identity.driverGuid, lastSeenName: identity.lastSeenName, userId: identity.userId },
          update: { userId: identity.userId },
        });
      }
      for (const mapping of mappings) {
        await prisma.carMapping.upsert({
          where: { gameCarName: mapping.gameCarName },
          create: { id: mapping.id, gameCarName: mapping.gameCarName, displayName: mapping.displayName, secondaryDisplayName: mapping.secondaryDisplayName },
          update: {},
        });
      }

      const bytes = new TextEncoder().encode(JSON.stringify(original.rawJson));
      const created = await results.createUpload({ filename: original.filename, bytes: bytes.buffer as ArrayBuffer }, actor);
      if (!created.ok) return { status: "failed", differences: [], note: `createUpload: ${created.error}` };
      const id = created.upload.id;

      // The pure parse must write nothing, and say what the writing parse then does
      const identitiesBefore = JSON.stringify(await prisma.driverIdentity.findMany({ where: { driverGuid: { in: guids } }, orderBy: { driverGuid: "asc" } }));
      const preview = await results.parseUpload(id, { write: false });
      const identitiesAfter = JSON.stringify(await prisma.driverIdentity.findMany({ where: { driverGuid: { in: guids } }, orderBy: { driverGuid: "asc" } }));
      const untouched = await prisma.rawResultUpload.findUniqueOrThrow({ where: { id }, include: { parseReport: true } });
      const differences: Difference[] = [];
      if (identitiesBefore !== identitiesAfter) differences.push({ table: "parseUpload(write: false)", field: "DriverIdentity written", key: "-", expected: "no change", actual: "changed" });
      if (untouched.parseReport || untouched.status !== "UPLOADED") differences.push({ table: "parseUpload(write: false)", field: "upload written", key: "-", expected: "UPLOADED, no report", actual: untouched.status });

      const parsed = await results.parseUpload(id, { write: true, actor });
      if (!parsed.ok) return { status: "failed", differences, note: `parseUpload: ${parsed.error}` };
      if (!preview.ok || JSON.stringify(preview.report) !== JSON.stringify(parsed.report) || preview.upload.status !== parsed.upload.status) {
        differences.push({ table: "parseUpload(write: false)", field: "report", key: "-", expected: parsed.upload.status, actual: preview.ok ? preview.upload.status : preview.error });
      }

      const bound = await results.bindUpload(
        { uploadId: id, eventId: original.eventId, pointsSystem: original.pointsSystem, sessionLabel: original.sessionLabel },
        actor,
      );
      if (!bound.ok) return { status: "failed", differences, note: `bindUpload: ${bound.error}` };
      if (bound.upload.pointsSystem !== original.pointsSystem) {
        differences.push({ table: "RawResultUpload", field: "pointsSystem", key: "-", expected: original.pointsSystem, actual: bound.upload.pointsSystem });
      }

      let ingested;
      try {
        ingested = await results.ingestUpload(id, actor);
      } catch (error) {
        return { status: "failed", differences, note: `ingestUpload threw: ${error instanceof Error ? error.message.split("\n").filter(Boolean).slice(-1)[0] : String(error)}` };
      }
      if (!ingested.ok) return { status: "failed", differences, note: `ingestUpload: ${ingested.error}` };

      const replayed = await prisma.rawResultUpload.findUniqueOrThrow({
        where: { id },
        include: { parseReport: true, ingestedSessions: { include: raceInclude } },
      });
      if (replayed.status !== "INGESTED") differences.push({ table: "RawResultUpload", field: "status", key: "-", expected: "INGESTED", actual: replayed.status });

      const report = (r: typeof original.parseReport) =>
        r ? { drivers: r.drivers, resultsCount: r.resultsCount, lapsCount: r.lapsCount, anomalies: r.anomalies } : null;
      if (JSON.stringify(report(original.parseReport)) !== JSON.stringify(report(replayed.parseReport))) {
        const left = report(original.parseReport) ?? {};
        const right = report(replayed.parseReport) ?? {};
        for (const field of ["drivers", "resultsCount", "lapsCount", "anomalies"] as const) {
          if (JSON.stringify((left as Row)[field]) !== JSON.stringify((right as Row)[field])) {
            differences.push({ table: "ParseReport", field, key: "-", expected: (left as Row)[field], actual: (right as Row)[field] });
          }
        }
      }

      // A file without a date starts "now", so its start time can't match
      const ignoreStartedAt = !file.Date;
      const mine = normalize(replayed.ingestedSessions[0] as unknown as SessionRows, ignoreStartedAt);
      // Older uploads could be ingested twice (before the row lock); the replay must match one of them
      let best: Difference[] | undefined;
      for (const session of original.ingestedSessions) {
        const diff = compare(normalize(session as unknown as SessionRows, ignoreStartedAt), mine);
        if (!best || diff.length < best.length) best = diff;
      }
      differences.push(...(best ?? []));
      const note = original.ingestedSessions.length > 1 ? `${original.ingestedSessions.length} sessions in ${evalName} (ingested twice before the lock)` : undefined;
      return { status: differences.length ? "differ" : "match", differences, note };
    }

    const tally = { match: 0, differ: 0, failed: 0 };
    const byField = new Map<string, { rows: number; uploads: Set<string> }>();
    for (const upload of uploads) {
      let outcome: Outcome;
      try {
        outcome = await replay(upload.id);
      } catch (error) {
        outcome = { status: "failed", differences: [], note: error instanceof Error ? error.message.split("\n").filter(Boolean).slice(-1)[0] : String(error) };
      }
      tally[outcome.status]++;
      const label = `${upload.filename} (${upload.id.slice(0, 8)})`;
      const fields = new Map<string, number>();
      for (const d of outcome.differences) {
        const name = `${d.table}.${d.field}`;
        fields.set(name, (fields.get(name) ?? 0) + 1);
        const entry = byField.get(name) ?? { rows: 0, uploads: new Set<string>() };
        entry.rows++;
        entry.uploads.add(upload.id);
        byField.set(name, entry);
      }
      const summary = [...fields].map(([name, n]) => `${name} x${n}`).join(", ");
      const tag = outcome.status === "match" ? "PASS" : outcome.status === "differ" ? "DIFF" : "FAIL";
      console.log(`${tag}  ${label}${summary ? `  ${summary}` : ""}${outcome.note ? `  [${outcome.note}]` : ""}`);
      if (VERBOSE) {
        for (const d of outcome.differences.slice(0, 20)) {
          console.log(`        ${d.table}.${d.field} [${d.key}]: ${JSON.stringify(d.expected)} -> ${JSON.stringify(d.actual)}`);
        }
        if (outcome.differences.length > 20) console.log(`        … and ${outcome.differences.length - 20} more`);
      }
    }

    console.log(`\n${tally.match} match, ${tally.differ} differ, ${tally.failed} failed (of ${uploads.length}).`);
    if (byField.size) {
      console.log(`Differences by field (${evalName} -> replay; --verbose shows values):`);
      for (const [name, { rows, uploads: ids }] of [...byField].sort((a, b) => b[1].rows - a[1].rows)) {
        console.log(`  ${name.padEnd(40)} ${rows} row(s) in ${ids.size} upload(s)`);
      }
    }
    return tally.differ + tally.failed === 0 ? 0 : 1;
  } finally {
    await replayDb?.$disconnect();
    await adminDb.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${THROWAWAY}" WITH (FORCE)`);
    console.log(`Dropped ${THROWAWAY}.`);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await evalDb.$disconnect();
    await adminDb.$disconnect();
  });
