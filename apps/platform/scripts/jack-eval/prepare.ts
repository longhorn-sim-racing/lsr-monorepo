/**
 * Gets the eval copy ready for a Jack 2.0 run (design §16). LOCAL ONLY.
 *
 *   pnpm --filter @lsr/platform jack:eval:prepare                       # the lsr_eval copy on the local server
 *   pnpm --filter @lsr/platform jack:eval:prepare --db=lsr_eval_test    # another copy (its name starts with lsr_eval)
 *
 * 1. Applies the app's migrations to it (`prisma migrate deploy`): on a fresh copy of production, that's
 *    the jack-2 ones. They're additive, and the scheduler's pg_cron setup skips itself on a copy.
 * 2. Runs every track's fake seeder (scripts/jack-eval/seed/<track>.ts) against it, with JACK_FAKES=all,
 *    so connector syncs read the fake services (start them with `pnpm jack:fakes` when a seeder needs them).
 *
 * Options: --db=<name>, --track=<track> (one track's seeders), --skip-migrate, --skip-seed.
 *
 * It takes the server from DATABASE_URL (the environment, or apps/platform/.env.local and .env), refuses
 * anything but 127.0.0.1 or localhost, and only works on databases whose name starts with lsr_eval.
 * Then run the eval on that copy: `pnpm --filter @lsr/platform jack:eval --db=lsr_eval` (JACK_DATABASE_URL
 * gets the same database).
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { SLOT_TRACKS, type SlotTrack } from "../../src/lib/slots";
import { evalCopyUrl, parseDatabaseUrl } from "../../src/server/jack/eval-support";
import { APP_DIR, loadAppEnv } from "./env";

loadAppEnv();
(process.env as Record<string, string | undefined>).NODE_ENV ??= "production";

const args = process.argv.slice(2);
const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const DB = arg("db") ?? "lsr_eval";
const TRACK = arg("track");
const SKIP_MIGRATE = args.includes("--skip-migrate");
const SKIP_SEED = args.includes("--skip-seed");

async function main() {
  const target = evalCopyUrl(process.env.DATABASE_URL, DB);
  if (!target.ok) {
    console.error(target.error);
    process.exit(1);
  }
  if (TRACK && !(SLOT_TRACKS as readonly string[]).includes(TRACK)) {
    console.error(`--track must be one of ${SLOT_TRACKS.join(", ")} (got "${TRACK}").`);
    process.exit(1);
  }
  const where = parseDatabaseUrl(target.url)!;
  const rule = "=".repeat(78);
  console.log(`${rule}\n  JACK EVAL PREPARE on the LOCAL database ${where.host}:${where.port}/${where.database}\n${rule}`);

  if (!SKIP_MIGRATE) {
    console.log("\n  Applying migrations (prisma migrate deploy)...\n");
    const cli = require.resolve("prisma/build/index.js");
    const result = spawnSync(process.execPath, [cli, "migrate", "deploy", "--schema", resolve(APP_DIR, "prisma", "schema.prisma")], {
      cwd: APP_DIR,
      env: { ...process.env, DATABASE_URL: target.url, DIRECT_URL: target.url },
      stdio: "inherit",
    });
    if (result.status !== 0) {
      console.error(`\n  prisma migrate deploy failed (exit ${result.status ?? result.signal}); nothing was seeded.`);
      process.exit(1);
    }
  }
  if (SKIP_SEED) return;

  // Everything loaded from here on (the Prisma client, the connectors) sees the eval copy and the fakes
  process.env.DATABASE_URL = target.url;
  process.env.DIRECT_URL = target.url;
  process.env.JACK_FAKES ??= "all";
  const [{ prisma }, { EVAL_SEEDERS }] = await Promise.all([import("../../src/server/db"), import("./seed")]);
  const seeders = EVAL_SEEDERS.filter((s) => !TRACK || s.track === (TRACK as SlotTrack));
  console.log(`\n  Seeding fake data (JACK_FAKES=${process.env.JACK_FAKES}): ${seeders.length ? `${seeders.length} seeder${seeders.length === 1 ? "" : "s"}` : "no track has a seeder yet"}\n`);
  let failed = 0;
  try {
    for (const seeder of seeders) {
      const t0 = Date.now();
      try {
        const summary = await seeder.run({ prisma, now: new Date(), log: (line) => console.log(`         ${line}`) });
        console.log(`  ok    ${seeder.track.padEnd(18)} ${seeder.name}${summary ? `: ${summary}` : ""} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      } catch (error) {
        failed++;
        console.log(`  FAIL  ${seeder.track.padEnd(18)} ${seeder.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
  if (failed) {
    console.error(`\n  ${failed} seeder${failed === 1 ? "" : "s"} failed.`);
    process.exitCode = 1;
  } else console.log(`\n  Ready. Run the eval on it with --db=${DB}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
