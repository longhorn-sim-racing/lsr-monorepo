/**
 * Makes the staff badges on the site match the officer roster on /about.
 *
 * Badges come from the database (each user's officerTitle plus the officer/admin roles), while
 * /about reads src/app/about/roster.ts. When the roster changes, run this to bring the
 * database in line:
 * - every roster officer with an account gets the officer role (admins keep admin) and their
 *   roster title, e.g. "Media Officer" or "Business Lead";
 * - anyone else with the officer role or a title loses both. Admin roles are never added or
 *   removed here; admins who aren't on the roster are only reported.
 *
 * Accounts are matched by display name, or by HANDLES below when the names differ. Add
 * `--map "Roster Name=handle"` for a one-off match. Unmatched officers are listed so they can
 * sign up first.
 *
 * Dry run by default: prints the plan and writes nothing.
 *
 *   DATABASE_URL=… pnpm --filter @lsr/platform exec tsx scripts/sync-officer-badges.ts
 *   DATABASE_URL=… pnpm --filter @lsr/platform exec tsx scripts/sync-officer-badges.ts --apply --actor you@utexas.edu
 *
 * Reads no .env file; DIRECT_URL is preferred over DATABASE_URL when both are set.
 */
import { OFFICERS, TEAMS, type Officer } from "../src/app/about/roster";

const APPLY = process.argv.includes("--apply");

if (process.env.DIRECT_URL) process.env.DATABASE_URL = process.env.DIRECT_URL;
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL (or DIRECT_URL) must be set in the environment. No .env file is read.");
  process.exit(1);
}
(process.env as Record<string, string | undefined>).NODE_ENV ??= "production";

/** Roster names whose site account goes by another name. */
const HANDLES: Record<string, string> = {
  "Constanza Jongkind": "connie-jongkind",
  "George Lawrence": "leorge-gawrence",
  "Alexander Spears": "alexander-jae-spears",
};

function argValues(flag: string): string[] {
  const values: string[] = [];
  process.argv.forEach((arg, i) => {
    if (arg === flag && process.argv[i + 1]) values.push(process.argv[i + 1]);
  });
  return values;
}

for (const pair of argValues("--map")) {
  const [name, handle] = pair.split("=").map((s) => s.trim());
  if (!name || !handle) {
    console.error(`--map expects "Roster Name=handle", got "${pair}"`);
    process.exit(1);
  }
  HANDLES[name] = handle.replace(/^@/, "").toLowerCase();
}

/** The badge text for a roster entry: generic "Officer" titles get their team's name. */
function badgeTitle(officer: Officer): string {
  if (officer.title !== "Officer") return officer.title;
  const team = TEAMS.find((t) => t.id === officer.team);
  return team ? `${team.name} Officer` : officer.title;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

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
  const { createAuditLog } = await import("../src/server/audit/log");

  console.log(`target   ${describeTarget(process.env.DATABASE_URL!)}`);
  console.log(`mode     ${APPLY ? "APPLY — will write" : "dry run — nothing is written"}\n`);

  const users = await prisma.user.findMany({
    where: { status: { not: "deleted" } },
    select: {
      id: true,
      handle: true,
      displayName: true,
      officerTitle: true,
      roles: { select: { role: { select: { key: true } } } },
    },
  });
  const roleKeys = (u: (typeof users)[number]) => u.roles.map((r) => r.role.key);
  const officerRole = await prisma.role.findUnique({ where: { key: "officer" } });
  if (!officerRole) throw new Error('The "officer" role is missing.');

  type Change = { userId: string; label: string; title: string | null; addOfficer: boolean; removeOfficer: boolean };
  const changes: Change[] = [];
  const unmatched: string[] = [];
  const matchedIds = new Set<string>();

  for (const officer of OFFICERS) {
    const handle = HANDLES[officer.name];
    const candidates = handle
      ? users.filter((u) => u.handle === handle)
      : users.filter((u) => norm(u.displayName) === norm(officer.name));
    if (candidates.length !== 1) {
      unmatched.push(`${officer.name}: ${candidates.length ? `${candidates.length} accounts (${candidates.map((u) => "@" + u.handle).join(", ")}); pick one with --map` : "no account"}`);
      continue;
    }
    const user = candidates[0];
    matchedIds.add(user.id);
    const title = badgeTitle(officer);
    const keys = roleKeys(user);
    const addOfficer = !keys.includes("officer") && !keys.includes("admin");
    if (user.officerTitle !== title || addOfficer) {
      changes.push({
        userId: user.id,
        label: `${officer.name} (@${user.handle})`,
        title,
        addOfficer,
        removeOfficer: false,
      });
      console.log(
        `  update  ${officer.name} (@${user.handle}): ${JSON.stringify(user.officerTitle)} → ${JSON.stringify(title)}${addOfficer ? ", add officer role" : ""}`
      );
    } else {
      console.log(`  ok      ${officer.name} (@${user.handle}): ${JSON.stringify(title)}`);
    }
  }

  const adminsOffRoster: string[] = [];
  for (const user of users) {
    if (matchedIds.has(user.id)) continue;
    const keys = roleKeys(user);
    if (keys.includes("admin")) adminsOffRoster.push(`${user.displayName} (@${user.handle}), title ${JSON.stringify(user.officerTitle)}`);
    const removeOfficer = keys.includes("officer");
    if (!removeOfficer && !user.officerTitle) continue;
    changes.push({ userId: user.id, label: `${user.displayName} (@${user.handle})`, title: null, addOfficer: false, removeOfficer });
    console.log(
      `  remove  ${user.displayName} (@${user.handle}): ${removeOfficer ? "officer role, " : ""}title ${JSON.stringify(user.officerTitle)}`
    );
  }

  if (unmatched.length) console.log(`\nOn the roster without a match:\n${unmatched.map((u) => `  ${u}`).join("\n")}`);
  if (adminsOffRoster.length) {
    console.log(`\nAdmins not on the roster (left alone; they still show a staff badge):\n${adminsOffRoster.map((a) => `  ${a}`).join("\n")}`);
  }
  console.log(`\n${changes.length} change${changes.length === 1 ? "" : "s"} planned.`);

  if (!APPLY || changes.length === 0) {
    if (!APPLY) console.log("Dry run. Re-run with --apply --actor <your email or handle> to write.");
    await prisma.$disconnect();
    return;
  }

  const actorArg = argValues("--actor")[0];
  const actor = actorArg
    ? await prisma.user.findFirst({ where: { OR: [{ email: actorArg.toLowerCase() }, { handle: actorArg.replace(/^@/, "").toLowerCase() }] } })
    : null;
  if (!actor) {
    console.error("--apply needs --actor <your email or handle> so the audit log says who ran it.");
    process.exit(1);
  }

  await prisma.$transaction(async (tx) => {
    for (const change of changes) {
      const before = await tx.user.findUniqueOrThrow({
        where: { id: change.userId },
        select: { officerTitle: true, roles: { select: { role: { select: { key: true } } } } },
      });
      await tx.user.update({ where: { id: change.userId }, data: { officerTitle: change.title } });
      if (change.addOfficer) {
        await tx.userRole.upsert({
          where: { userId_roleId: { userId: change.userId, roleId: officerRole.id } },
          create: { userId: change.userId, roleId: officerRole.id },
          update: {},
        });
      }
      if (change.removeOfficer) {
        await tx.userRole.deleteMany({ where: { userId: change.userId, roleId: officerRole.id } });
      }
      const beforeRoles = before.roles.map((r) => r.role.key);
      const afterRoles = change.addOfficer
        ? [...beforeRoles, "officer"]
        : change.removeOfficer
          ? beforeRoles.filter((r) => r !== "officer")
          : beforeRoles;
      await createAuditLog(
        {
          actorUserId: actor.id,
          actionType: "UPDATE",
          entityType: "USER",
          entityId: change.userId,
          targetUserId: change.userId,
          summary: `Synced staff badge for ${change.label} with the officer roster`,
          before: { officerTitle: before.officerTitle, roles: beforeRoles },
          after: { officerTitle: change.title, roles: afterRoles },
          metadata: { source: "scripts/sync-officer-badges.ts" },
        },
        tx
      );
    }
  });

  console.log(`Applied ${changes.length} change${changes.length === 1 ? "" : "s"}.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
