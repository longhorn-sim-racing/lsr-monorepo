// Demo data for trying out the recruiting applicant side (and the admin side) on the LOCAL stack.
//
//   cd apps/platform
//   NODE_ENV=production npx tsx scripts/seed-recruiting-demo.ts            # create (or recreate) the demo data
//   NODE_ENV=production npx tsx scripts/seed-recruiting-demo.ts window closed     # round deadline passed
//   NODE_ENV=production npx tsx scripts/seed-recruiting-demo.ts window open       # open until Dec 31 (the seed default)
//   NODE_ENV=production npx tsx scripts/seed-recruiting-demo.ts window upcoming   # opens next month
//   NODE_ENV=production npx tsx scripts/seed-recruiting-demo.ts clean      # remove all demo accounts and their data
//   NODE_ENV=production npx tsx scripts/seed-recruiting-demo.ts mail you@gmail.com   # two accounts that use YOUR inbox (see below)
//
// The `mail` command is for checking that real email works. It creates an applicant with exactly the
// address you give (nothing started: submit an application as them and the confirmation lands in your
// inbox) and a second account at you+decide@... (Gmail delivers it to you too) whose application is
// already submitted, so an officer deciding it (Interview / Accepted / Not moving forward) emails you.
// The other demo accounts use @lsr-demo.test addresses that don't exist: don't send mail to them.
//
// (NODE_ENV=production only quiets Prisma's per-query logging.)
//
// Needs `npx supabase start` and a migrated + seeded database (`pnpm db:reset`: the seeded round `fall-2026`
// and the `recruiting` feature flag). It refuses to run unless the database and Supabase API are on localhost,
// and it never sends email (it does not touch the email code at all).
//
// Every demo account has an @lsr-demo.test address and the same password (DEMO_PASSWORD below), is
// email-confirmed, and has a racing number so the site's "choose your racing number" pop-up stays away.
// Re-running it deletes and recreates the demo accounts, so you can always get back to a clean state.

import { execSync } from "node:child_process";
import { prisma } from "../src/server/db";

const DEMO_DOMAIN = "@lsr-demo.test";
const DEMO_PASSWORD = "LsrDemo-2026!";
const ROUND_SLUG = "fall-2026";

// ---------------------------------------------------------------------------
// Local-only guards and the Supabase admin API
// ---------------------------------------------------------------------------

const isLocal = (u: string) => /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u) || /@(127\.0\.0\.1|localhost)[:/]/.test(u);

if (!isLocal(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL does not point at localhost.");
  process.exit(1);
}

function supabaseLocal(): { apiUrl: string; serviceKey: string } {
  let apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  let serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!apiUrl || !serviceKey) {
    const env = execSync("npx supabase status -o env", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const read = (k: string) => env.match(new RegExp(`^${k}="?([^"\\r\\n]+)"?`, "m"))?.[1] ?? "";
    apiUrl = apiUrl || read("API_URL");
    serviceKey = serviceKey || read("SERVICE_ROLE_KEY");
  }
  if (!apiUrl || !serviceKey) throw new Error("Could not read the local Supabase API URL and service key. Is `npx supabase start` running?");
  if (!isLocal(apiUrl)) throw new Error(`Refusing to run: Supabase API ${apiUrl} is not on localhost.`);
  return { apiUrl, serviceKey };
}

type AuthUser = { id: string; email: string };

async function authApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { apiUrl, serviceKey } = supabaseLocal();
  const res = await fetch(`${apiUrl}/auth/v1/admin${path}`, {
    ...init,
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Supabase auth ${init.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Clean up
// ---------------------------------------------------------------------------

const MAIL_HANDLE_PREFIX = "mailtest-";

/** Deletes the matching app users (and everything attached to them) and their Supabase Auth accounts. */
/** `alsoAuthSuffix` also removes leftover Auth-only accounts with that address ending (e.g. from a half-finished run). */
async function removeAccounts(where: { OR: Array<Record<string, unknown>> }, alsoAuthSuffix?: string): Promise<number> {
  const users = await prisma.user.findMany({ where: where as never, select: { id: true, email: true } });
  const ids = users.map((u) => u.id);
  const emails = new Set(users.map((u) => u.email.toLowerCase()));
  const apps = await prisma.application.findMany({ where: { userId: { in: ids } }, select: { id: true, tracks: { select: { id: true } } } });
  const entityIds = apps.flatMap((a) => [a.id, ...a.tracks.map((t) => t.id)]);
  await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: entityIds } }, { actorUserId: { in: ids } }, { targetUserId: { in: ids } }] } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } }); // cascades applications, teams, reviews, emails, roles
  for (let page = 1; page < 50; page++) {
    const body = await authApi<{ users: AuthUser[] }>(`/users?page=${page}&per_page=200`);
    for (const u of body.users) if (u.email && (emails.has(u.email.toLowerCase()) || (alsoAuthSuffix && u.email.endsWith(alsoAuthSuffix)))) await authApi(`/users/${u.id}`, { method: "DELETE" });
    if (body.users.length < 200) break;
  }
  return ids.length;
}

/** `includeMail` also removes the accounts made by the `mail` command (only the explicit `clean` command does). */
async function clean(includeMail = true) {
  const n = await removeAccounts({ OR: [{ email: { endsWith: DEMO_DOMAIN } }, ...(includeMail ? [{ handle: { startsWith: MAIL_HANDLE_PREFIX } }] : [])] }, DEMO_DOMAIN);
  const cycle = await prisma.recruitingCycle.findUnique({ where: { slug: ROUND_SLUG } });
  if (cycle) await prisma.recruitingTrackConfig.deleteMany({ where: { cycleId: cycle.id, schedulingUrl: { startsWith: "https://calendar.app.google/demo-" } } });
  console.log(`Removed ${n} demo accounts and everything attached to them.`);
}

// ---------------------------------------------------------------------------
// The round window
// ---------------------------------------------------------------------------

async function setWindow(which: string) {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const windows: Record<string, { opensAt: Date; closesAt: Date; label: string }> = {
    open: { opensAt: new Date("2026-10-01T00:00:00Z"), closesAt: new Date("2026-12-31T23:59:00Z"), label: "open until Dec 31 (the seed default)" },
    closed: { opensAt: new Date(now - 14 * day), closesAt: new Date(now - 60 * 1000), label: "closed one minute ago" },
    upcoming: { opensAt: new Date(now + 30 * day), closesAt: new Date(now + 45 * day), label: "opens in 30 days" },
  };
  const w = windows[which];
  if (!w) throw new Error("Use: window open | closed | upcoming");
  const cycle = await prisma.recruitingCycle.findUnique({ where: { slug: ROUND_SLUG } });
  if (!cycle) throw new Error("The seeded round fall-2026 is missing (run `pnpm db:reset`).");
  await prisma.recruitingCycle.update({ where: { id: cycle.id }, data: { opensAt: w.opensAt, closesAt: w.closesAt, isActive: true } });
  console.log(`Round "${cycle.name}" is now ${w.label}.`);
}

// ---------------------------------------------------------------------------
// Demo content
// ---------------------------------------------------------------------------

const TECH = {
  tech_areas: ["UI/UX design", "Race data and stats (results, live timing)"],
  tech_experience: "Personal or class projects",
  tech_built: "I built a lap-time tracker for my iRacing league and want to build live timing overlays at LSR.",
  tech_link: "https://github.com/ada-demo/lap-tracker",
  tech_hours: "3–5",
};
const COMMUNITY = {
  comm_interest: ["Sim Racing", "Formula 1"],
  comm_why: "I love bringing people together around racing and want more students to find the club.",
  comm_organized: "I ran my dorm's movie nights and a 40-person charity 5K.",
  comm_event: "A watch party for a Grand Prix, followed by a sim race on the same track.",
  comm_hours: "1–3",
};
const RESUME = "https://drive.google.com/file/d/demo-resume/view";

const LONG_TEXT = "Racing is my life. ".repeat(79).slice(0, 1500); // exactly the 1500-character limit
const HOSTILE_NAME = `<img src=x onerror=alert(1)> Zoë "Quote" O'Brien`;

type Spec = {
  key: string;
  name: string;
  roles?: Array<"officer" | "admin">;
  title?: string;
  status?: "active" | "pending_verification";
  noProfile?: boolean;
};

const ACCOUNTS: Spec[] = [
  // Officers (any officer can see and decide every team's applications for now; the title is just a label)
  { key: "admin", name: "Avery Admin", roles: ["admin"], title: "Webmaster" },
  { key: "tech-lead", name: "Tara Tech-Lead", roles: ["officer"], title: "Technology Lead" },
  { key: "community-lead", name: "Casey Community-Lead", roles: ["officer"], title: "Community Lead" },
  { key: "ops-officer", name: "Olive Ops-Officer", roles: ["officer"], title: "Operations" },
  // Applicants in every state
  { key: "fresh", name: "Fiona Fresh" },
  { key: "unverified", name: "Uma Unverified", status: "pending_verification" },
  { key: "draft-about", name: "Maya Draft-About" },
  { key: "draft-tech", name: "Noah Draft-Tech" },
  { key: "draft-ready", name: "Priya Draft-Ready" },
  { key: "sub-tech", name: "Sam Submitted-Tech" },
  { key: "sub-both", name: "Dana Submitted-Both" },
  { key: "accepted", name: "Alex Accepted" },
  { key: "auto", name: "Auto Auto-Submitted" },
  { key: "edge", name: HOSTILE_NAME },
];

async function seed() {
  const cycle = await prisma.recruitingCycle.findUnique({ where: { slug: ROUND_SLUG } });
  if (!cycle) throw new Error("The seeded round fall-2026 is missing (run `pnpm db:reset`).");

  await clean(false); // keeps any accounts made by the `mail` command
  await prisma.featureFlag.upsert({ where: { key: "recruiting" }, update: { enabled: true }, create: { key: "recruiting", enabled: true } });
  await setWindow("open");

  const roles = Object.fromEntries((await prisma.role.findMany()).map((r) => [r.key, r.id]));
  for (const k of ["officer", "admin"]) if (!roles[k]) throw new Error(`Role "${k}" is missing (run \`pnpm db:reset\`).`);

  // Accounts: a Supabase Auth user (so you can sign in) and the matching app User
  const users: Record<string, { id: string; email: string }> = {};
  let n = 0;
  for (const a of ACCOUNTS) {
    n += 1;
    const email = `${a.key}${DEMO_DOMAIN}`;
    const auth = await authApi<AuthUser>("/users", {
      method: "POST",
      body: JSON.stringify({ email, password: DEMO_PASSWORD, email_confirm: true, user_metadata: { full_name: a.name } }),
    });
    await prisma.user.create({
      data: {
        id: auth.id,
        email,
        handle: `demo-${a.key}`,
        displayName: a.name,
        status: a.status ?? "active",
        officerTitle: a.title ?? null,
        racingNumber: 900 + n,
        eid: a.key === "fresh" || a.key === "unverified" ? null : `dm${String(n).padStart(3, "0")}`.slice(0, 16),
        gradYear: a.key === "fresh" ? null : 2027 + (n % 3),
        major: a.key === "fresh" ? null : "Computer Science",
        roles: a.roles ? { create: a.roles.map((r) => ({ roleId: roles[r] })) } : undefined,
      },
    });
    users[a.key] = { id: auth.id, email };
  }
  const u = (k: string) => users[k];

  // Interview booking links (both teams interview)
  for (const [track, slug] of [["technology", "tech"], ["community", "community"]] as const) {
    await prisma.recruitingTrackConfig.upsert({
      where: { cycleId_track: { cycleId: cycle.id, track } },
      update: { schedulingUrl: `https://calendar.app.google/demo-${slug}` },
      create: { cycleId: cycle.id, track, schedulingUrl: `https://calendar.app.google/demo-${slug}` },
    });
  }

  // One application. Profile fields are copied from the account, like the real form does.
  type TrackSpec = { track: string; answers: Record<string, unknown>; status?: "SUBMITTED" | "IN_REVIEW" | "INTERVIEW" | "ACCEPTED" | "REJECTED"; by?: string };
  async function application(
    key: string,
    opts: { state: "DRAFT" | "SUBMITTED"; step?: string; tracks: TrackSpec[]; resume?: string | null; autoSubmitted?: boolean; submittedAt?: Date; profile?: Partial<{ fullName: string; major: string; eid: string }> },
  ) {
    const acct = ACCOUNTS.find((a) => a.key === key)!;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: u(key).id } });
    const submitted = opts.state === "SUBMITTED";
    const created = await prisma.application.create({
      data: {
        cycleId: cycle!.id,
        userId: user.id,
        formVersion: cycle!.formVersion,
        state: opts.state,
        fullName: opts.profile?.fullName ?? acct.name,
        email: user.email,
        eid: opts.profile?.eid ?? user.eid,
        gradYear: user.gradYear,
        major: opts.profile?.major ?? user.major,
        resumeUrl: opts.resume === undefined ? RESUME : opts.resume,
        draftStep: opts.step ?? null,
        submittedAt: submitted ? (opts.submittedAt ?? new Date()) : null,
        autoSubmitted: opts.autoSubmitted ?? false,
        tracks: {
          create: opts.tracks.map((t) => ({
            track: t.track,
            answers: t.answers as never,
            status: t.status ?? "SUBMITTED",
            decidedAt: t.status && t.status !== "SUBMITTED" ? new Date() : null,
            decidedById: t.by ? u(t.by).id : null,
          })),
        },
      },
      include: { tracks: true },
    });
    return created;
  }

  // Drafts (never visible to officers)
  await application("draft-about", { state: "DRAFT", step: "about", tracks: [], resume: null });
  await application("draft-tech", {
    state: "DRAFT",
    step: "team:technology",
    tracks: [{ track: "technology", answers: { tech_areas: ["Infrastructure and DevOps"], tech_experience: "Classes or tutorials" } }],
    resume: null,
  });
  await application("draft-ready", {
    state: "DRAFT",
    step: "review",
    tracks: [{ track: "technology", answers: TECH }, { track: "community", answers: COMMUNITY }],
  });

  // Submitted
  await application("sub-tech", { state: "SUBMITTED", tracks: [{ track: "technology", answers: TECH }] });

  const both = await application("sub-both", {
    state: "SUBMITTED",
    tracks: [
      { track: "technology", answers: TECH, status: "IN_REVIEW", by: "tech-lead" },
      { track: "community", answers: COMMUNITY, status: "INTERVIEW", by: "community-lead" },
    ],
  });
  const bothTech = both.tracks.find((t) => t.track === "technology")!;
  await prisma.applicationReview.createMany({
    data: [
      { applicationTrackId: bothTech.id, reviewerId: u("tech-lead").id, score: 4, notes: "Strong project, good fit for the data side." },
      { applicationTrackId: bothTech.id, reviewerId: u("admin").id, score: 3, notes: "Needs more detail on hours." },
    ],
  });

  await application("accepted", {
    state: "SUBMITTED",
    tracks: [
      { track: "technology", answers: TECH, status: "ACCEPTED", by: "tech-lead" },
      { track: "community", answers: COMMUNITY, status: "REJECTED", by: "community-lead" },
    ],
  });

  await application("auto", {
    state: "SUBMITTED",
    autoSubmitted: true,
    submittedAt: new Date("2026-10-10T23:59:00Z"),
    tracks: [{ track: "community", answers: COMMUNITY }],
  });

  // Hostile content, written straight to the database (the form would refuse most of it): how do the
  // officer pages, the applicant's own pages and the CSV export cope?
  await application("edge", {
    state: "SUBMITTED",
    profile: { fullName: HOSTILE_NAME, major: "=cmd|' /C calc'!A0", eid: "@SUM(1+1)" },
    resume: "https://example.com/résumé?x=1&y=<b>bold</b>",
    tracks: [
      {
        track: "technology",
        answers: {
          ...TECH,
          tech_built: `<script>alert('xss')</script> **bold** {{statusUrl}} ‮RTL override‬ ${"🏎️".repeat(5)}\n\nSecond paragraph.`,
          tech_link: "javascript:alert(document.cookie)",
        },
      },
      { track: "community", answers: { ...COMMUNITY, comm_why: LONG_TEXT, comm_event: `=1+1 and +cmd and @SUM and -2+3 and "quotes", commas, and\nnewlines` } },
    ],
  });

  // Officers who also applied (both to Technology): nobody can decide their own application, but the other lead can
  await application("tech-lead", { state: "SUBMITTED", tracks: [{ track: "technology", answers: TECH }] });
  await application("community-lead", { state: "SUBMITTED", tracks: [{ track: "technology", answers: TECH }] });

  // Confirmation emails that "failed" (there is no email key locally): for the officers' Emails page
  const subTech = await prisma.application.findFirstOrThrow({ where: { userId: u("sub-tech").id } });
  await prisma.applicationEmail.create({
    data: {
      applicationId: subTech.id,
      template: "RECEIVED",
      toEmail: u("sub-tech").email,
      subject: "We received your application (demo)",
      body: "Demo row: this was never sent.",
      status: "FAILED",
      error: "Email service not configured",
    },
  });

  console.log("\nDemo data is ready. Password for every account:", DEMO_PASSWORD);
  console.log("\nAccounts (sign in at http://127.0.0.1:3000/auth/signin):");
  for (const a of ACCOUNTS) console.log(`  ${(a.key + DEMO_DOMAIN).padEnd(34)} ${a.roles ? `[${a.roles.join(",")}] ${a.title ?? ""}` : ""}`);
  console.log("\nBoth officer-lead accounts and the admin see every team's applications. See docs/recruiting-local-testing.md for what to check.");
}

async function mail(address: string | undefined) {
  if (!address || !/^[^\s@+]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error("Usage: mail you@example.com (an address without a + in it)");
  if (address.toLowerCase().endsWith(DEMO_DOMAIN)) throw new Error("Give a real address you can read, not a demo one.");
  const cycle = await prisma.recruitingCycle.findUnique({ where: { slug: ROUND_SLUG } });
  if (!cycle) throw new Error("The seeded round fall-2026 is missing (run `pnpm db:reset`).");
  const [local, domain] = address.split("@");
  const decideAddress = `${local}+decide@${domain}`;

  await removeAccounts({ OR: [{ handle: { startsWith: MAIL_HANDLE_PREFIX } }, { email: { in: [address, decideAddress] } }] });
  await prisma.featureFlag.upsert({ where: { key: "recruiting" }, update: { enabled: true }, create: { key: "recruiting", enabled: true } });
  for (const [track, slug] of [["technology", "tech"], ["community", "community"]] as const) {
    await prisma.recruitingTrackConfig.upsert({
      where: { cycleId_track: { cycleId: cycle.id, track } },
      update: { schedulingUrl: `https://calendar.app.google/demo-${slug}` },
      create: { cycleId: cycle.id, track, schedulingUrl: `https://calendar.app.google/demo-${slug}` },
    });
  }

  async function account(handleKey: string, email: string, name: string, n: number) {
    const auth = await authApi<AuthUser>("/users", {
      method: "POST",
      body: JSON.stringify({ email, password: DEMO_PASSWORD, email_confirm: true, user_metadata: { full_name: name } }),
    });
    return prisma.user.create({
      data: { id: auth.id, email, handle: `${MAIL_HANDLE_PREFIX}${handleKey}`, displayName: name, racingNumber: 980 + n, eid: `mt00${n}`, gradYear: 2028, major: "Computer Science" },
    });
  }
  await account("apply", address, "Mail Test Applicant", 1);
  const decide = await account("decide", decideAddress, "Mail Test Decide", 2);
  await prisma.application.create({
    data: {
      cycleId: cycle.id,
      userId: decide.id,
      formVersion: cycle.formVersion,
      state: "SUBMITTED",
      fullName: decide.displayName,
      email: decide.email,
      eid: decide.eid,
      gradYear: decide.gradYear,
      major: decide.major,
      resumeUrl: RESUME,
      submittedAt: new Date(),
      tracks: { create: [{ track: "technology", answers: TECH as never }, { track: "community", answers: COMMUNITY as never }] },
    },
  });

  console.log(`
Two accounts now use your inbox (password for both: ${DEMO_PASSWORD}):
  ${address}   an applicant with nothing started. Submit an application as them: the confirmation email goes to ${address}.
  ${decideAddress}   already submitted to Technology and Community. Sign in as tech-lead@lsr-demo.test (or any officer),
        open "Mail Test Decide" and mark a team Interview / Accepted / Not moving forward with "send email" ticked.

For real email the dev server must have a working RESEND_API_KEY (apps/platform/.env.local has one) and must NOT be started with it blanked.
If a send fails, the reason is shown on /admin/recruiting/emails.`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (!cmd || cmd === "seed") return seed();
  if (cmd === "window") return setWindow(arg ?? "");
  if (cmd === "clean") return clean();
  if (cmd === "mail") return mail(arg);
  throw new Error(`Unknown command "${cmd}". Use: (none) | window open|closed|upcoming | mail you@example.com | clean`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
