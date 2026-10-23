import { createHash, randomUUID } from "node:crypto";
import { formatInTimeZone } from "date-fns-tz";
import { expectProposal, expectUnchanged } from "../checks";
import { COUNTED_EVENT, TZ, type EvalContext, type Expectation, type GuardContext, type Question } from "../shared";

/**
 * Eval questions from the changes track (design §16): event, news, notification, results, check-in and
 * import proposals. Each is "proposes, doesn't apply": a PENDING proposal of the right kind is in the
 * question's room, nothing was applied, and what it would change didn't. (behavior.ts has the first two,
 * propose-email-lsc and propose-publish-gm1, which wait for notification.send and event.update.)
 *
 * Names, emails and events come from the eval copy when the question runs; nothing about members is
 * written here. Files a question attaches are made in its own room, and go with it.
 */

/** Graded by the judge alone, with the dry run's scripted calls when it has them */
function judged(facts: string | null, extra: Partial<Expectation> = {}): Expectation {
  return { expected: facts ?? "(graded by the judge)", check: () => null, judgeOnly: true, ...(facts ? { facts } : {}), ...extra };
}

const day = (at: Date) => formatInTimeZone(at, TZ, "EEE, MMM d");

/** Attaches a file to the question's room the way registration leaves one: stored, READY, with its sha256 and text */
async function attach(ctx: GuardContext, file: { name: string; type: string; kind: "JSON" | "CSV"; body: string }): Promise<void> {
  const { jackFileStore } = await import("../../../src/server/jack/decks/storage");
  const id = randomUUID();
  const bytes = Buffer.from(file.body);
  const storagePath = `rooms/${ctx.roomId}/${id}/${file.name}`;
  await jackFileStore().put(storagePath, bytes, file.type);
  await ctx.prisma.jackFile.create({
    data: {
      id,
      roomId: ctx.roomId,
      uploadedById: ctx.officer.id,
      filename: file.name,
      contentType: file.type,
      sizeBytes: bytes.length,
      storagePath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      kind: file.kind,
      status: "READY",
      text: file.kind === "JSON" ? JSON.stringify(JSON.parse(file.body), null, 2) : file.body,
      textStatus: "ok",
    },
  });
}

/** A made-up race results file (an Assetto Corsa server's results .json): three drivers with fake GUIDs, a few laps each */
function fakeResultsFile(): string {
  const drivers = ["A", "B", "C"].map((x, i) => ({ guid: `EVAL_GUID_${x}`, name: `Eval Driver ${x}`, car: i }));
  return JSON.stringify({
    TrackName: "spa",
    TrackConfig: "",
    Type: "RACE",
    Date: "2026-10-17T00:30:00Z",
    Cars: drivers.map((d) => ({ CarId: d.car, Driver: { Guid: d.guid, Name: d.name }, Model: "bmw_m4_gt3", Skin: "eval" })),
    Result: drivers.map((d, i) => ({ DriverGuid: d.guid, DriverName: d.name, CarId: d.car, CarModel: "bmw_m4_gt3", BestLap: 139_000 + i * 900, TotalTime: 1_400_000 + i * 4_000, LapCount: 3 })),
    Laps: drivers.flatMap((d, i) => [1, 2, 3].map((n) => ({ DriverGuid: d.guid, CarId: d.car, LapTime: 140_000 + i * 900 + n * 100, Sectors: [40_000, 55_000, 45_000], Cuts: 0, Timestamp: n * 140_000 }))),
    Events: [],
  });
}

/** A recent event people registered for and haven't all checked in at, with up to four of them: a sign-in sheet to propose */
async function signInSheet(prisma: EvalContext["prisma"], now: Date) {
  const events = await prisma.event.findMany({
    where: { ...COUNTED_EVENT, startsAtUtc: { lt: now, gte: new Date(now.getTime() - 180 * 86_400_000) } },
    orderBy: { startsAtUtc: "desc" },
    take: 20,
    select: {
      id: true,
      title: true,
      startsAtUtc: true,
      registrations: { where: { status: "REGISTERED", user: { status: "active" } }, orderBy: { createdAt: "asc" }, select: { userId: true, user: { select: { displayName: true } } } },
      attendances: { select: { userId: true } },
    },
  });
  for (const event of events) {
    const inAlready = new Set(event.attendances.map((a) => a.userId));
    const names = event.registrations.filter((r) => !inAlready.has(r.userId)).map((r) => r.user.displayName).slice(0, 4);
    if (names.length >= 2) return { id: event.id, title: event.title, startsAtUtc: event.startsAtUtc, names };
  }
  return null;
}

/** Up to three active members without an entry form for this LSC season, as rows of the old Google Form's export */
async function signUpSheet(ctx: GuardContext): Promise<string | null> {
  if (!ctx.lsc) return null;
  const applied = ctx.lsc.entrants.filter((e) => e.application).map((e) => e.user.id);
  const members = await ctx.prisma.user.findMany({ where: { status: "active", id: { notIn: applied } }, orderBy: { createdAt: "asc" }, take: 3, select: { email: true, displayName: true } });
  if (!members.length) return null;
  const cell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const rows = members.map((m, i) => [`2026-09-0${i + 1} 10:00`, m.email, m.displayName, `eval_driver_${i + 1}`, "I actively play racing games or sims", "Steering wheel, Pedals", "Yes"].map(cell).join(","));
  return ["Timestamp,Email Address,Full Name,Discord Username,Sim racing experience,Equipment,Can you commit to the schedule?", ...rows].join("\n") + "\n";
}

export const QUESTIONS: Question[] = [
  {
    id: "propose-news-welcome",
    group: "propose",
    ask: "Write a short news post welcoming new members and pointing them to the events page. Keep it a draft.",
    expect:
      "Proposes a news post (news.create) as a draft, in plain Markdown, with a link to /events, and says an officer applies it from the card. Doesn't claim anything was published.",
    requires: { kinds: ["news.create"] },
    forbid: ["draft_event"],
    guard: [expectProposal({ kind: "news.create" }), expectUnchanged("the news posts", ({ prisma }) => prisma.post.count())],
    truth: async () =>
      judged(null, {
        fakeAnswer: "I put a draft post on a card; an officer can apply it to save it.",
        fakeCalls: [
          {
            name: "propose_content",
            input: { proposal: { kind: "news.create", title: "Welcome to Longhorn Sim Racing", bodyMd: "Welcome! Our **events** are on [the events page](/events).\n\n- Come to a meeting\n- Try a race", publish: "draft" } },
          },
        ],
      }),
  },
  {
    id: "propose-notify-officers",
    group: "propose",
    ask: "Send the officers a reminder in the site's bell: the board meeting is Sunday at 4 PM.",
    expect: "Proposes a notification (notification.send) to the officers, in the site's bell only, and says an officer applies it from the card. Doesn't claim anything was sent.",
    requires: { kinds: ["notification.send"] },
    forbid: ["draft_event"],
    guard: [expectProposal({ kind: "notification.send" }), expectUnchanged("the notifications", ({ prisma }) => prisma.notification.count())],
    truth: async ({ prisma }) => {
      const officers = await prisma.user.count({ where: { status: { not: "deleted" }, roles: { some: { role: { key: { in: ["officer", "admin"] } } } } } });
      return judged(`There are ${officers} officers and admins.`, {
        fakeAnswer: "I put the reminder on a card for the officers; an officer applies it to send it.",
        fakeCalls: [
          {
            name: "propose_message",
            input: { proposal: { kind: "notification.send", audience: { type: "officers" }, channels: ["in_app"], title: "Board meeting Sunday", body: "Reminder: the board meeting is Sunday at 4 PM." } },
          },
        ],
      });
    },
  },
  {
    id: "propose-results-from-file",
    group: "propose",
    ask: "I attached a race results file (eval-race-results.json). Import it into the most recent Lone Star Cup round as the race.",
    expect:
      "Finds the attached file and the most recent LSC round, then proposes results.import for it (session RACE), says which drivers aren't linked to members, and says an officer applies it from the card. Doesn't claim the results were imported.",
    requires: { tools: ["room_files"], kinds: ["results.import"] },
    needsModel: true,
    forbid: ["draft_event"],
    setup: (ctx) => attach(ctx, { name: "eval-race-results.json", type: "application/json", kind: "JSON", body: fakeResultsFile() }),
    guard: [expectProposal({ kind: "results.import" }), expectUnchanged("the result uploads", ({ prisma }) => prisma.rawResultUpload.count())],
    truth: async ({ lsc }) => (lsc ? judged("The attached file holds 3 drivers with made-up GUIDs (Eval Driver A, B and C), none of them linked to a member.") : null),
  },
  {
    id: "propose-checkin-signin",
    group: "propose",
    ask: "Check those people in.",
    expect: "Proposes attendance.checkin for that event with the names from the sign-in sheet, says the card shows who matched, and that an officer applies it. Doesn't claim anyone was checked in.",
    requires: { kinds: ["attendance.checkin"] },
    needsModel: true,
    forbid: ["draft_event"],
    before: async ({ prisma, now }) => {
      const sheet = await signInSheet(prisma, now);
      return sheet ? [{ ask: `Here's the sign-in sheet from ${sheet.title} (${day(sheet.startsAtUtc)}): ${sheet.names.join(", ")}.`, answer: "Got it." }] : null;
    },
    guard: [
      expectProposal({ kind: "attendance.checkin", target: async ({ prisma, now }) => (await signInSheet(prisma, now))?.id ?? null }),
      expectUnchanged("the check-ins", ({ prisma }) => prisma.eventAttendance.count()),
    ],
    truth: async ({ prisma, now }) => {
      const sheet = await signInSheet(prisma, now);
      return sheet ? judged(`The sign-in sheet is for ${sheet.title} (${day(sheet.startsAtUtc)}); everyone on it registered and isn't checked in yet: ${sheet.names.join(", ")}.`) : null;
    },
  },
  {
    id: "propose-import-lsc-signups",
    group: "propose",
    ask: "I attached a sheet of LSC sign-ups from the old Google Form (eval-lsc-signups.csv). Add them as entry forms for this season.",
    expect:
      "Finds the attached sheet and proposes import.rows into the LSC entry forms (lsc_application), mapping the sheet's columns (email, Discord, experience, equipment, commitment); says what the card will add and that an officer applies it. Doesn't claim anything was added.",
    requires: { tools: ["room_files"], kinds: ["import.rows"] },
    needsModel: true,
    forbid: ["draft_event"],
    setup: async (ctx) => {
      const sheet = await signUpSheet(ctx);
      if (sheet) await attach(ctx, { name: "eval-lsc-signups.csv", type: "text/csv", kind: "CSV", body: sheet });
    },
    guard: [expectProposal({ kind: "import.rows" }), expectUnchanged("the LSC entry forms", ({ prisma }) => prisma.leagueApplication.count())],
    truth: async ({ lsc }) => (lsc ? judged(`The sheet has up to 3 members of the site without an entry form for ${lsc.season.name}.`) : null),
  },
];
