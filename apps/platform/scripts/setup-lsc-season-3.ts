/**
 * Stands up Lone Star Cup Season 3 (Fall 2026) and archives Season 2.
 *
 * - links the lone-star-cup-s2 season to the Lone Star Cup league (it was created unlinked),
 * - creates the lone-star-cup-s3 event series and season, running Sep 19 – Nov 21,
 * - creates the ten S3 race events from the comp team's "LSC Schedule 2026 Fall" doc.
 *
 * S3 becomes the league's open season, so the /lone-star-cup page shows it as current,
 * S2 moves to the archive, and league entry fees buy S3.
 *
 * Dry run by default: prints the plan and writes nothing. Existing rows are left as they
 * are (admins may have edited them), so it's safe to re-run.
 *
 *   DATABASE_URL=… pnpm --filter @lsr/platform exec tsx scripts/setup-lsc-season-3.ts
 *   DATABASE_URL=… pnpm --filter @lsr/platform exec tsx scripts/setup-lsc-season-3.ts --apply
 *
 * Reads no .env file; DIRECT_URL is preferred over DATABASE_URL when both are set.
 */
import { fromZonedTime } from "date-fns-tz";

const APPLY = process.argv.includes("--apply");

if (process.env.DIRECT_URL) process.env.DATABASE_URL = process.env.DIRECT_URL;
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL (or DIRECT_URL) must be set in the environment. No .env file is read.");
  process.exit(1);
}
(process.env as Record<string, string | undefined>).NODE_ENV ??= "production";

const TZ = "America/Chicago";
const LEAGUE_SLUG = "lone-star-cup";
const SERIES = { slug: "lone-star-cup-s3", title: "Lone Star Cup S3" };
const SEASON = {
  slug: "lone-star-cup-s3",
  name: "Lone Star Cup | Season 3",
  year: 2026,
  startAt: fromZonedTime("2026-09-19T00:00:00", TZ),
  endAt: fromZonedTime("2026-11-21T23:59:59.999", TZ),
};
const VENUE_NAME = "Virtual - Assetto Corsa";
const SUMMARY = "30 min practice, 10 min qualifying, 30 min race in the Mustang GT4.";

// Saturdays at 10am Central, from the comp team's schedule.
const ROUNDS: { date: string; track: string; slug: string; title?: string }[] = [
  { date: "2026-09-19", track: "Daytona", slug: "daytona" },
  { date: "2026-09-26", track: "Indianapolis Road Course", slug: "indianapolis" },
  { date: "2026-10-03", track: "Brands Hatch", slug: "brands-hatch" },
  { date: "2026-10-10", track: "Okayama", slug: "okayama" },
  { date: "2026-10-17", track: "Long Beach", slug: "long-beach" },
  { date: "2026-10-24", track: "Spa", slug: "spa" },
  {
    date: "2026-10-31",
    track: "Mount Panorama",
    slug: "mount-panorama",
    title: "Lone Star Cup S3 Round 7 @ Mount Panorama (Halloween Night Race)",
  },
  { date: "2026-11-07", track: "Road America", slug: "road-america" },
  { date: "2026-11-14", track: "Hockenheim", slug: "hockenheim" },
  { date: "2026-11-21", track: "Fuji Speedway", slug: "fuji", title: "Lone Star Cup S3 FINAL Round @ Fuji Speedway" },
];

function describeTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

async function main() {
  const { prisma } = await import("../src/server/db");

  console.log(`target   ${describeTarget(process.env.DATABASE_URL!)}`);
  console.log(`mode     ${APPLY ? "APPLY — will write" : "dry run — nothing is written"}\n`);

  const league = await prisma.league.findUnique({ where: { slug: LEAGUE_SLUG } });
  if (!league) throw new Error(`League ${LEAGUE_SLUG} not found.`);
  const venue = await prisma.venue.findFirst({ where: { name: VENUE_NAME } });
  if (!venue) console.log(`! venue "${VENUE_NAME}" not found; events will have no venue`);

  const s2 = await prisma.season.findUnique({ where: { slug: "lone-star-cup-s2" } });
  const plan: string[] = [];

  if (s2 && s2.leagueId !== league.id) plan.push("link season lone-star-cup-s2 to the league");
  const series = await prisma.eventSeries.findUnique({ where: { slug: SERIES.slug } });
  if (!series) plan.push(`create event series ${SERIES.slug}`);
  const season = await prisma.season.findUnique({ where: { slug: SEASON.slug } });
  if (!season) plan.push(`create season ${SEASON.slug} (${ROUNDS[0].date} → ${ROUNDS.at(-1)!.date})`);
  else if (season.leagueId !== league.id) plan.push(`link season ${SEASON.slug} to the league`);

  const events = ROUNDS.map((r, i) => {
    const round = i + 1;
    const startsAtUtc = fromZonedTime(`${r.date}T10:00:00`, TZ);
    return {
      slug: `lone-star-cup-s3-round-${round}-${r.slug}`,
      title: r.title ?? `Lone Star Cup S3 Round ${round} @ ${r.track}`,
      roundNumber: round,
      startsAtUtc,
      endsAtUtc: new Date(startsAtUtc.getTime() + 2 * 60 * 60 * 1000),
    };
  });
  const existingEvents = new Set(
    (await prisma.event.findMany({ where: { slug: { in: events.map((e) => e.slug) } }, select: { slug: true } })).map((e) => e.slug)
  );
  for (const e of events) {
    plan.push(`${existingEvents.has(e.slug) ? "keep  " : "create"} ${e.slug}  ${e.startsAtUtc.toISOString()}`);
  }

  console.log(plan.map((p) => `  ${p}`).join("\n"));
  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write.");
    await prisma.$disconnect();
    return;
  }

  await prisma.$transaction(async (tx) => {
    if (s2 && s2.leagueId !== league.id) {
      await tx.season.update({ where: { id: s2.id }, data: { leagueId: league.id } });
    }
    const s3Series =
      series ?? (await tx.eventSeries.create({ data: { slug: SERIES.slug, title: SERIES.title, visibility: "public" } }));
    if (!season) {
      await tx.season.create({
        data: {
          ...SEASON,
          leagueId: league.id,
          seriesId: s3Series.id,
          pointsRule: s2?.pointsRule ?? undefined,
          visibility: "public",
        },
      });
    } else if (season.leagueId !== league.id) {
      await tx.season.update({ where: { id: season.id }, data: { leagueId: league.id } });
    }
    const now = new Date();
    for (const e of events) {
      if (existingEvents.has(e.slug)) continue;
      await tx.event.create({
        data: {
          ...e,
          summary: SUMMARY,
          timezone: TZ,
          status: "PUBLISHED",
          visibility: "public",
          publishedAt: now,
          seriesId: s3Series.id,
          venueId: venue?.id,
        },
      });
    }
  });

  console.log("\nDone.");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
