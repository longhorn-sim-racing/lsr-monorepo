/**
 * Read-only snapshot of a league's open season, for the weekly Tech Team meeting:
 * entry forms, entries and what they brought in, recent payments, which races have
 * results uploaded, and whether the rules page is published.
 *
 * Prints counts only (no names or emails), so the output is safe to paste into Teams.
 *
 *   DATABASE_URL=… pnpm --filter @lsr/platform exec tsx scripts/lsc-status.ts
 *   DATABASE_URL=… pnpm --filter @lsr/platform exec tsx scripts/lsc-status.ts --since=2026-09-29
 *
 * --since (a date, Central time) sets the window for "recent" payments and sign-ups; it
 * defaults to seven days ago. --league=<slug> picks another league (default lone-star-cup).
 *
 * Writes nothing. The database comes from the environment, never a .env file; DIRECT_URL is
 * preferred over DATABASE_URL when both are set.
 */
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

const TZ = "America/Chicago";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const LEAGUE_SLUG = arg("league") ?? "lone-star-cup";
const sinceArg = arg("since");
const SINCE = sinceArg ? fromZonedTime(`${sinceArg}T00:00:00`, TZ) : new Date(Date.now() - 7 * 86_400_000);

if (process.argv.includes("--since") || sinceArg === "" || Number.isNaN(SINCE.getTime())) {
  console.error(`--since must be a date like --since=2026-09-29${sinceArg ? ` (got "${sinceArg}")` : ""}.`);
  process.exit(1);
}
if (process.env.DIRECT_URL) process.env.DATABASE_URL = process.env.DIRECT_URL;
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL (or DIRECT_URL) must be set in the environment. No .env file is read.");
  process.exit(1);
}
(process.env as Record<string, string | undefined>).NODE_ENV ??= "production";

const day = (d: Date) => formatInTimeZone(d, TZ, "EEE MMM d");
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const tally = (values: string[]) => {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return counts.size ? Array.from(counts, ([k, n]) => `${k} ${n}`).join(" · ") : "none";
};

async function main() {
  const { prisma } = await import("../src/server/db");
  const { getOpenLeagueSeason, listSeasonEntrants } = await import("../src/server/services/league-entry.service");
  const { LSC_RULES_SLUG } = await import("../src/lib/page-slugs");

  const now = new Date();
  const league = await prisma.league.findUnique({ where: { slug: LEAGUE_SLUG } });
  if (!league) throw new Error(`No league with slug "${LEAGUE_SLUG}".`);

  const season = await getOpenLeagueSeason(league.id, now);
  console.log(`${league.name} status, ${formatInTimeZone(now, TZ, "EEE MMM d, h:mm a")} CT`);
  console.log(`"Recent" = since ${day(SINCE)}\n`);
  if (!season) {
    console.log("No open season: entry is closed until the next season is set up.");
    await prisma.$disconnect();
    return;
  }
  console.log(`Season: ${season.name} (${season.startAt ? day(season.startAt) : "?"} – ${season.endAt ? day(season.endAt) : "no end date"})`);

  // Entry: one row per driver with a form, an entry, or both.
  const product = await prisma.product.findFirst({ where: { type: "LEAGUE_FEE", leagueId: league.id } });
  console.log(
    product
      ? `Product: ${product.name}, ${dollars(product.amountCents)}, ${product.active ? "on sale" : "OFF"}`
      : "Product: none for this league"
  );

  const roster = await listSeasonEntrants(season.id);
  const entrants = roster?.entrants ?? [];
  const withForm = entrants.filter((e) => e.application);
  const paid = entrants.filter((e) => e.status === "paid");
  const revenue = paid.reduce((sum, e) => sum + (e.entry?.payment?.amountCents ?? 0), 0);
  const returning = paid.filter(
    (e) => (e.entry?.payment?.metadata as Record<string, unknown> | null)?.priceTier === "returning"
  ).length;

  console.log("\nEntry");
  console.log(`  Entry forms:        ${withForm.length} (${tally(withForm.map((e) => e.application!.source))})`);
  console.log(`  New forms recently: ${withForm.filter((e) => e.application!.createdAt >= SINCE).length}`);
  console.log(`  Entries:            ${tally(entrants.map((e) => e.status).filter((s) => s !== "none"))}`);
  console.log(`  Form, no entry:     ${withForm.filter((e) => e.status === "none" || e.status === "ended").length}`);
  console.log(`  Paid in:            ${dollars(revenue)} from ${paid.length} paid entries (${returning} at the returning price)`);

  // Payments for this league's products. Refunds happen in the Stripe dashboard, never here.
  const payments = await prisma.payment.findMany({
    where: { product: { leagueId: league.id } },
    select: { status: true, createdAt: true, metadata: true },
  });
  const recent = payments.filter((p) => p.createdAt >= SINCE);
  const flagged = payments.filter(
    (p) => p.status === "succeeded" && (p.metadata as Record<string, unknown> | null)?.duplicateOfEntitlementId
  ).length;
  console.log("\nPayments");
  console.log(`  Checkouts started recently: ${recent.length} (${tally(recent.map((p) => p.status))})`);
  console.log(`  Flagged duplicates, all time: ${flagged}${flagged ? " (check /admin/payments for refunds)" : ""}`);

  // Races: the season's events, through its event series.
  console.log("\nRaces");
  if (!season.seriesId) {
    console.log("  The season has no event series, so no races to list.");
  } else {
    const events = await prisma.event.findMany({
      where: { seriesId: season.seriesId },
      orderBy: { startsAtUtc: "asc" },
      select: {
        title: true,
        startsAtUtc: true,
        heroImageUrl: true,
        _count: { select: { rawResultUploads: true, ingestedSessions: true } },
      },
    });
    let missing = 0;
    for (const e of events) {
      const past = e.startsAtUtc < now;
      const results = e._count.ingestedSessions
        ? "results in"
        : e._count.rawResultUploads
          ? "uploaded, not processed"
          : past
            ? "NO RESULTS"
            : "upcoming";
      if (past && !e._count.ingestedSessions) missing++;
      console.log(`  ${day(e.startsAtUtc).padEnd(10)}  ${results.padEnd(23)}  ${e.heroImageUrl ? "     " : "no img"}  ${e.title}`);
    }
    console.log(`  ${events.filter((e) => e.startsAtUtc < now).length} of ${events.length} run, ${missing} missing results`);
  }

  if (LEAGUE_SLUG === "lone-star-cup") {
    const rules = await prisma.page.findUnique({
      where: { slug: LSC_RULES_SLUG },
      select: { visibility: true, updatedAt: true },
    });
    console.log(
      `\nRules page: ${rules ? `${rules.visibility === "public" ? "published" : `draft (${rules.visibility} only)`}, last edited ${day(rules.updatedAt)}` : "not created"}`
    );
  }

  const [users, newUsers] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: SINCE } } }),
  ]);
  console.log(`Site accounts: ${users} (${newUsers} new recently)`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
