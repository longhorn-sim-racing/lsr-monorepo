/**
 * Backfills LSC entry forms from the comp team's Google Form responses.
 *
 * Download the responses sheet as CSV (File → Download → .csv), then run this against it.
 * Each row is matched to a site account by email, then by UT EID. Matched drivers get a
 * LeagueApplication for the open Lone Star Cup season (source GOOGLE_FORM) unless they
 * already have one; unmatched rows are listed so the comp team can chase sign-ups or add
 * them by hand in /admin/league-entries. Payment isn't touched: applicants still pay on
 * the site, or an admin enters them manually there.
 *
 * Dry run by default: prints the plan and writes nothing.
 *
 *   DATABASE_URL=… pnpm --filter @lsr/platform exec tsx scripts/import-lsc-applications.ts responses.csv
 *   DATABASE_URL=… pnpm --filter @lsr/platform exec tsx scripts/import-lsc-applications.ts responses.csv --apply
 *
 * Reads no .env file; DIRECT_URL is preferred over DATABASE_URL when both are set.
 */
import { readFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const file = process.argv.slice(2).find((a) => !a.startsWith("--"));

if (!file) {
  console.error("Usage: import-lsc-applications.ts <responses.csv> [--apply]");
  process.exit(1);
}
if (process.env.DIRECT_URL) process.env.DATABASE_URL = process.env.DIRECT_URL;
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL (or DIRECT_URL) must be set in the environment. No .env file is read.");
  process.exit(1);
}
(process.env as Record<string, string | undefined>).NODE_ENV ??= "production";

/** Minimal RFC 4180 parser: quoted fields, doubled quotes, newlines inside quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim()));
}

/** Finds a column by a phrase from the form question, so reworded headers still line up. */
function column(header: string[], ...phrases: string[]): number {
  return header.findIndex((h) => phrases.some((p) => h.toLowerCase().includes(p)));
}

function experienceFrom(answer: string) {
  const a = answer.toLowerCase();
  if (a.includes("competitive")) return "COMPETITIVE" as const;
  if (a.includes("actively")) return "SIM_RACER" as const;
  if (a.includes("played")) return "CASUAL" as const;
  return "NONE" as const;
}

function equipmentFrom(answer: string) {
  const a = answer.toLowerCase();
  const list: ("WHEEL" | "PEDALS" | "CONTROLLER" | "KEYBOARD")[] = [];
  if (a.includes("wheel")) list.push("WHEEL");
  if (a.includes("pedal")) list.push("PEDALS");
  if (a.includes("controller")) list.push("CONTROLLER");
  if (a.includes("keyboard")) list.push("KEYBOARD");
  return list.length ? list : (["CONTROLLER"] as const).slice();
}

/** UT EIDs look like 2–3 letters then digits (e.g. abc123). Anything else is a school name. */
const looksLikeEid = (v: string) => /^[a-z]{2,3}\d{2,5}$/i.test(v.trim());

async function main() {
  const { prisma } = await import("../src/server/db");
  const { getOpenLeagueSeason } = await import("../src/server/services/league-entry.service");

  const [header, ...rows] = parseCsv(readFileSync(file!, "utf8"));
  const col = {
    name: column(header, "name"),
    eid: column(header, "uteid", "ut eid", "eid"),
    email: column(header, "email"),
    discord: column(header, "discord"),
    experience: column(header, "experience"),
    equipment: column(header, "equipment"),
    commit: column(header, "commit"),
    questions: column(header, "questions"),
  };
  const missing = Object.entries(col).filter(([, i]) => i < 0).map(([k]) => k);
  if (missing.length) throw new Error(`Couldn't find columns: ${missing.join(", ")}`);

  const league = await prisma.league.findUnique({ where: { slug: "lone-star-cup" } });
  const season = league ? await getOpenLeagueSeason(league.id) : null;
  if (!season) throw new Error("No open Lone Star Cup season. Run setup-lsc-season-3.ts first.");
  console.log(`season   ${season.slug}`);
  console.log(`mode     ${APPLY ? "APPLY — will write" : "dry run — nothing is written"}\n`);

  const seen = new Set<string>();
  let created = 0;
  for (const r of rows) {
    const name = r[col.name]?.trim() ?? "";
    const email = r[col.email]?.trim().toLowerCase() ?? "";
    const eidOrSchool = r[col.eid]?.trim() ?? "";
    const eid = looksLikeEid(eidOrSchool) ? eidOrSchool.toLowerCase() : null;
    if (!name && !email) continue;

    const user =
      (email && (await prisma.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } } }))) ||
      (eid && (await prisma.user.findUnique({ where: { eid } }))) ||
      null;
    if (!user) {
      console.log(`  ? no account   ${name} <${email}>${eid ? ` ${eid}` : ""}`);
      continue;
    }
    if (seen.has(user.id)) {
      console.log(`  = duplicate    ${name} → @${user.handle} (later row skipped)`);
      continue;
    }
    seen.add(user.id);

    const existing = await prisma.leagueApplication.findUnique({
      where: { userId_seasonId: { userId: user.id, seasonId: season.id } },
    });
    if (existing) {
      console.log(`  · has a form   ${name} → @${user.handle}`);
      continue;
    }

    const commit = (r[col.commit] ?? "").toLowerCase();
    const data = {
      userId: user.id,
      seasonId: season.id,
      discordUsername: r[col.discord]?.trim() || "(not given)",
      experience: experienceFrom(r[col.experience] ?? ""),
      equipment: equipmentFrom(r[col.equipment] ?? ""),
      canCommit: commit.startsWith("yes") || commit.includes("but yes"),
      school: eid || !eidOrSchool ? null : eidOrSchool,
      notes: ["na", "n/a", "no", "none", ""].includes((r[col.questions] ?? "").trim().toLowerCase())
        ? null
        : r[col.questions].trim(),
      source: "GOOGLE_FORM" as const,
    };
    console.log(`  + import       ${name} → @${user.handle}  discord=${data.discordUsername}`);
    created++;
    if (APPLY) {
      await prisma.leagueApplication.create({ data });
      if (eid && !user.eid && !(await prisma.user.findUnique({ where: { eid } }))) {
        await prisma.user.update({ where: { id: user.id }, data: { eid } });
      }
    }
  }

  console.log(`\n${created} form(s) ${APPLY ? "imported" : "to import"}.${APPLY ? "" : " Re-run with --apply to write."}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
