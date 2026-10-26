/**
 * Makes the staff badges on the site match the officer roster on /about.
 *
 * Badges come from the database (each user's officerTitle plus the officer/admin roles), while
 * /about reads src/app/about/roster.ts. When the roster changes, update HANDLES below and run
 * this to bring the database in line:
 * - every roster officer in HANDLES gets the officer role (admins keep admin), their roster
 *   title, e.g. "Media Officer" or "Business Lead", and their officer profile's department (the
 *   roster team) and board seat, which Jack reads (#188);
 * - anyone else with the officer role, a title, a department or a board seat loses them. Admins are
 *   never changed here, only reported, and accounts that might belong to an unmapped roster
 *   officer are skipped. "What I work on" is the officer's own and is never touched.
 *
 * Only HANDLES (or `--map "Roster Name=handle"` for a one-off) decides who gets a badge. Display
 * names are only used to suggest handles, because members can set their own display name.
 *
 * Dry run by default: prints the plan and writes nothing.
 *
 *   DATABASE_URL=… pnpm --filter @lsr/platform exec tsx scripts/sync-officer-badges.ts
 *   DATABASE_URL=… pnpm --filter @lsr/platform exec tsx scripts/sync-officer-badges.ts --apply --actor you@utexas.edu
 *
 * Reads no .env file; DIRECT_URL is preferred over DATABASE_URL when both are set.
 */
import { OFFICERS, TEAMS, type Officer, type TeamId } from "../src/app/about/roster";

const APPLY = process.argv.includes("--apply");

if (process.env.DIRECT_URL) process.env.DATABASE_URL = process.env.DIRECT_URL;
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL (or DIRECT_URL) must be set in the environment. No .env file is read.");
  process.exit(1);
}
(process.env as Record<string, string | undefined>).NODE_ENV ??= "production";

/** Each roster officer's site handle. Officers without an account yet are left out. */
const HANDLES: Record<string, string> = {
  "Dylan Foley": "dylan-foley",
  "Bryan Reyes": "bryan-reyes",
  "Armando Martinez": "armando-martinez",
  "Mark Yuan": "zeste",
  "Prakul Sherikar": "prakul-sherikar",
  "Jacob Pineda": "jacob-pineda",
  "Constanza Jongkind": "connie-jongkind",
  "George Lawrence": "leorge-gawrence",
  "Alejandro Palacios": "alejandro-palacios",
  "Grant Ruhland": "grant-ruhland",
  "Diane Chagoya": "diane-chagoya",
  "Anuja Manjrekar": "anuja-manjrekar",
  "Harshika Mandula": "harshika-mandula",
  "Leisha Jhamnani": "leisha-jhamnani",
  "Jaylon Collins": "jaylon-collins",
  "Boen Kelly": "boen-kelly",
  "Jose Varela": "jose-varela",
  "Cooper Tomlin": "cooper-tomlin",
  "Gray Marshall": "gray-marshall",
  "Alexander Spears": "alexander-jae-spears",
  "Arav Agarwal": "arav-agarwal",
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

for (const name of Object.keys(HANDLES)) {
  if (!OFFICERS.some((o) => o.name === name)) {
    console.error(`HANDLES has "${name}", who isn't on the roster. Fix the name or remove the entry.`);
    process.exit(1);
  }
}

/** The badge text for a roster entry: generic "Officer" titles get their team's name. */
function badgeTitle(officer: Officer): string {
  if (officer.title !== "Officer") return officer.title;
  const team = TEAMS.find((t) => t.id === officer.team);
  return team ? `${team.name} Officer` : officer.title;
}

/** Lowercased, accents folded (Peña → pena), single spaces. */
const norm = (s: string) =>
  s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

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
      email: true,
      displayName: true,
      status: true,
      officerTitle: true,
      department: true,
      isBoard: true,
      roles: { select: { role: { select: { key: true } } } },
    },
  });
  type U = (typeof users)[number];
  const roleKeys = (u: U) => u.roles.map((r) => r.role.key);
  const who = (u: U) => `${u.displayName} (@${u.handle}, ${u.email.split("@")[1]})`;
  const officerRole = await prisma.role.findUnique({ where: { key: "officer" } });
  if (!officerRole) throw new Error('The "officer" role is missing.');

  type Change = {
    userId: string;
    label: string;
    title: string | null;
    department: TeamId | null;
    isBoard: boolean;
    addOfficer: boolean;
    removeOfficer: boolean;
  };
  /** What changes for a user, e.g. `"Media Officer" → "Media Lead", department null → "media"` */
  const describeChange = (u: U, next: { title: string | null; department: string | null; isBoard: boolean }) =>
    [
      u.officerTitle !== next.title ? `${JSON.stringify(u.officerTitle)} → ${JSON.stringify(next.title)}` : null,
      u.department !== next.department ? `department ${JSON.stringify(u.department)} → ${JSON.stringify(next.department)}` : null,
      u.isBoard !== next.isBoard ? `board ${u.isBoard} → ${next.isBoard}` : null,
    ]
      .filter(Boolean)
      .join(", ");
  const changes: Change[] = [];
  const notes: string[] = [];
  const mappedIds = new Set<string>();
  /** Accounts that might belong to an officer without a handle yet: never stripped. */
  const protectedIds = new Set<string>();

  for (const officer of OFFICERS) {
    const handle = HANDLES[officer.name];
    // Whatever happens below, accounts that might be this officer's are never stripped
    const candidates = users.filter((u) => norm(u.displayName).startsWith(norm(officer.name)));
    if (!handle) {
      candidates.forEach((u) => protectedIds.add(u.id));
      notes.push(
        candidates.length
          ? `${officer.name}: no handle yet; maybe ${candidates.map(who).join(" or ")}. Add to HANDLES or pass --map.`
          : `${officer.name}: no handle yet and no account found.`
      );
      continue;
    }
    const user = users.find((u) => u.handle === handle);
    if (!user) {
      candidates.forEach((u) => protectedIds.add(u.id));
      notes.push(`${officer.name}: no account with handle @${handle}.`);
      continue;
    }
    mappedIds.add(user.id);
    if (user.status !== "active") {
      candidates.forEach((u) => protectedIds.add(u.id));
      notes.push(`${officer.name}: @${handle} is ${user.status}; skipped.`);
      continue;
    }
    const next = { title: badgeTitle(officer), department: officer.team, isBoard: officer.board === true };
    const keys = roleKeys(user);
    const addOfficer = !keys.includes("officer") && !keys.includes("admin");
    const changed = describeChange(user, next);
    if (changed || addOfficer) {
      changes.push({ userId: user.id, label: who(user), ...next, addOfficer, removeOfficer: false });
      console.log(`  update  ${who(user)}: ${[changed, addOfficer ? "add officer role" : ""].filter(Boolean).join(", ")}`);
    } else {
      console.log(`  ok      ${who(user)}: ${JSON.stringify(next.title)}, ${next.department}${next.isBoard ? ", board" : ""}`);
    }
  }

  for (const user of users) {
    if (mappedIds.has(user.id)) continue;
    const keys = roleKeys(user);
    const removeOfficer = keys.includes("officer");
    if (!removeOfficer && !user.officerTitle && !user.department && !user.isBoard && !keys.includes("admin")) continue;
    if (keys.includes("admin")) {
      notes.push(`${who(user)} is an admin but not on the roster; left alone (title ${JSON.stringify(user.officerTitle)}, department ${JSON.stringify(user.department)}).`);
      continue;
    }
    if (protectedIds.has(user.id)) {
      notes.push(`${who(user)} might be an unmapped roster officer; left alone until mapped.`);
      continue;
    }
    const next = { title: null, department: null, isBoard: false };
    changes.push({ userId: user.id, label: who(user), ...next, addOfficer: false, removeOfficer });
    console.log(`  remove  ${who(user)}: ${[removeOfficer ? "officer role" : "", describeChange(user, next)].filter(Boolean).join(", ")}`);
  }

  if (notes.length) console.log(`\nNotes:\n${notes.map((n) => `  ${n}`).join("\n")}`);
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

  await prisma.$transaction(
    async (tx) => {
      for (const change of changes) {
        const before = await tx.user.findUniqueOrThrow({
          where: { id: change.userId },
          select: { officerTitle: true, department: true, isBoard: true, roles: { select: { role: { select: { key: true } } } } },
        });
        await tx.user.update({ where: { id: change.userId }, data: { officerTitle: change.title, department: change.department, isBoard: change.isBoard } });
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
            summary: `Synced staff badge and officer profile for ${change.label} with the officer roster`,
            before: { officerTitle: before.officerTitle, department: before.department, isBoard: before.isBoard, roles: beforeRoles },
            after: { officerTitle: change.title, department: change.department, isBoard: change.isBoard, roles: afterRoles },
            metadata: { source: "scripts/sync-officer-badges.ts" },
          },
          tx
        );
      }
    },
    // A first run makes a couple dozen changes over a remote connection; the default 5s is too short
    { timeout: 60_000, maxWait: 10_000 }
  );

  console.log(`Applied ${changes.length} change${changes.length === 1 ? "" : "s"}.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
