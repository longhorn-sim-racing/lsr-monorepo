/**
 * Checks the automation track (#188, design §11) against the LOCAL database: what unit tests can't,
 * because it lives in Postgres.
 *
 *   - a recurring question and its job are made together, and deleting the question deletes the job
 *     (the database trigger)
 *   - runs through the real reply loop (a scripted fake Claude, nothing paid): the scheduled note with
 *     its job key, answered as its owner by its persona; the next run's history holds the question and
 *     its last answer and not the room's conversation; the reply's cost counts as automation spend
 *   - the room busy: the note waits, the job's next run moves up a few minutes, the retry answers that
 *     note without asking again
 *   - the cap (JACK_AUTOMATION_BUDGET_USD=0 for the check): skipped, with one note a month
 *   - the cap's lock: questions due in the same moment, with room under the cap for one run, run at once
 *     and exactly one asks (each run counts the notes the earlier ones posted as under way)
 *   - pausing itself: an archived room, an owner who isn't an officer
 *   - recurring.upsert's prepare and apply against the real tables
 *   - another officer changing what a question asks takes it over (from the page, and from a proposal
 *     applied by someone else: the officer it was proposed for)
 *   - the weekly digest: every registered check runs against this database's schema without an error,
 *     the room note and Jack's summary, once a day
 *
 *   cd apps/platform
 *   NODE_ENV=production pnpm exec tsx scripts/check-automation.ts
 *
 * Refuses to run unless DATABASE_URL points at 127.0.0.1 or localhost. It never calls Claude or any
 * outside service and never broadcasts. It writes only rows it creates (tagged with one random word) and
 * deletes them at the end, pass or fail.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { localDatabaseProblem } from "../src/server/jack/eval-support";

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const databaseProblem = localDatabaseProblem("DATABASE_URL", process.env.DATABASE_URL);
if (databaseProblem) {
  console.error(`Refusing to run: ${databaseProblem}`);
  process.exit(1);
}
(process.env as Record<string, string | undefined>).NODE_ENV ??= "production";

let failed = false;
function check(step: string, ok: boolean, note?: string) {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${note ? `  (${note})` : ""}`);
}

async function main() {
  const { prisma } = await import("../src/server/db");
  const { fakeClaude } = await import("../src/server/jack/fake-claude");
  const { runRoom } = await import("../src/server/jack/reply-loop");
  const { createRecurringQuestion, deleteRecurringQuestion, updateRecurringQuestion } = await import("../src/server/automation/recurring/service");
  const { runRecurringQuestion, defaultRecurringRunDeps } = await import("../src/server/automation/recurring/run");
  const { runWeeklyDigest, defaultDigestRunDeps } = await import("../src/server/automation/digest/run");
  const { automationBudget, automationSpendUsd } = await import("../src/server/automation/cap");
  const { typicalRunUsd } = await import("../src/server/automation/recurring/estimate");
  const { failedChecks, runDigestChecks } = await import("../src/server/automation/run-checks");
  const { recurringUpsertKind, recurringUpsertSchema } = await import("../src/server/jack/proposals/automation/recurring-upsert");

  const tag = `zq${randomBytes(5).toString("hex")}`;
  const ids: Record<string, string[]> = {};
  const remember = (table: string, id: string) => {
    (ids[table] ??= []).push(id);
    return id;
  };
  console.log(`Tag: ${tag}`);

  // The real reply loop with a scripted Claude that says which call it is and what it was sent
  const claude = fakeClaude((_params, index) => ({ text: `Answer ${index + 1} ${tag}: 12 new accounts.`, usage: { input: 40_000, output: 1_500 } }));
  const replyDeps = { broadcast: async () => {}, getClient: () => claude.client, tools: [], budget: async () => ({ month: "October", spentUsd: 0, budgetUsd: 50 }) };
  const runDeps = { ...defaultRecurringRunDeps, broadcast: async () => {}, runRoom: (roomId: string, o: { startedAt: number }) => runRoom(roomId, replyDeps, o) };
  const historyOf = (call: number) =>
    (claude.calls[call]?.messages ?? []).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");

  try {
    const officerRole = await prisma.role.findUnique({ where: { key: "officer" } });
    if (!officerRole) throw new Error("No officer role in this database");
    const person = async (key: string, officer: boolean) => {
      const user = await prisma.user.create({ data: { email: `${tag}-${key}@example.test`, handle: `${tag}-${key}`, displayName: `Check ${key} ${tag}` } });
      remember("user", user.id);
      if (officer) await prisma.userRole.create({ data: { userId: user.id, roleId: officerRole.id } });
      return user;
    };
    const gray = await person("gray", true);
    const dylan = await person("dylan", true);
    const former = await person("former", false);
    const room = remember("room", (await prisma.jackRoom.create({ data: { title: `Automation check ${tag}`, createdById: gray.id, persona: "lift" } })).id);

    // ----- setting one up -----
    const made = await createRecurringQuestion(
      { title: `Weekly accounts ${tag}`, prompt: `How many new accounts this week ${tag}?`, roomId: room, persona: "stand", schedule: { every: "week", days: ["mon"], time: "09:00" } },
      { userId: gray.id },
      { enabled: true },
    );
    if (!made.ok) throw new Error(made.error);
    const question = made.question;
    const job = { id: question.scheduledJobId, key: question.scheduledJob.key };
    const ctx = () => ({ job, startedAt: Date.now(), log: () => {} });
    check("set up: the question and its job, keyed by the question, on its schedule", job.key === `recurring:${question.id}` && question.scheduledJob.kind === "recurring.question" && question.scheduledJob.schedule === "0 9 * * 1" && question.scheduledJob.enabled);

    // ----- a run, through the real reply loop -----
    const spentBefore = await automationSpendUsd();
    const first = await runRecurringQuestion(ctx(), runDeps);
    const notes = () => prisma.jackMessage.findMany({ where: { roomId: room, jobKey: job.key, scheduled: true }, orderBy: { createdAt: "asc" }, include: { answeredBy: true } });
    const [note] = await notes();
    check("run: posts the question as a scheduled note from its owner, with its job's key", Boolean(note?.scheduled && note.authorUserId === gray.id && note.content.startsWith(`Recurring question “Weekly accounts ${tag}”`)));
    check("run: the reply is Stand's (its persona, not the room's Lift), with its cost", note?.answeredBy?.persona === "stand" && Number(note.answeredBy.costUsd) > 0, first.summary);
    check("run: no web tools on the scheduled reply", !(claude.calls[0]?.tools ?? []).some((t) => "name" in t && /web_/.test(String(t.name))));
    const spentAfter = await automationSpendUsd();
    check("cap: the reply counts as automation spend", Math.abs(spentAfter - spentBefore - Number(note?.answeredBy?.costUsd ?? 0)) < 0.000_01, `${spentBefore} → ${spentAfter}`);

    // Officers talk in the room between runs (answered, as a room run would)
    const chat = await prisma.jackMessage.create({ data: { roomId: room, kind: "user", authorUserId: gray.id, content: `Private sponsor chat ${tag}` } });
    const chatReply = await prisma.jackMessage.create({ data: { roomId: room, kind: "assistant", persona: "lift", content: `Lift's take ${tag}`, model: "claude-opus-5-5" } });
    await prisma.jackMessage.update({ where: { id: chat.id }, data: { answeredById: chatReply.id } });

    await runRecurringQuestion(ctx(), runDeps);
    const history = historyOf(1);
    check("run again: the history holds the question and its last answer", history.includes(`Answer 1 ${tag}`) && (history.match(new RegExp(`How many new accounts this week ${tag}`, "g")) ?? []).length === 2);
    check("run again: and not the officers' conversation", !history.includes(`Private sponsor chat ${tag}`) && !history.includes(`Lift's take ${tag}`));

    // ----- the room busy -----
    await prisma.jackRoom.update({ where: { id: room }, data: { runId: `someone-else-${tag}`, runStartedAt: new Date() } });
    const before = Date.now();
    const busy = await runRecurringQuestion(ctx(), runDeps);
    const afterBusy = await prisma.scheduledJob.findUnique({ where: { id: job.id } });
    const waiting = (await notes()).at(-1)!;
    check("busy: the note waits and the job looks again in about 3 minutes", !waiting.answeredById && afterBusy!.nextRunAt.getTime() - before < 4 * 60_000 && afterBusy!.nextRunAt.getTime() - before > 2 * 60_000, busy.summary);
    await prisma.jackRoom.update({ where: { id: room }, data: { runId: null, runStartedAt: null } });
    await runRecurringQuestion(ctx(), runDeps);
    const afterRetry = await notes();
    check("busy: the retry answers that note and doesn't ask again", afterRetry.length === 3 && Boolean(afterRetry[2].answeredById));

    // ----- the cap -----
    const cap = process.env.JACK_AUTOMATION_BUDGET_USD;
    process.env.JACK_AUTOMATION_BUDGET_USD = "0";
    try {
      const capped = await runRecurringQuestion(ctx(), runDeps);
      await runRecurringQuestion(ctx(), runDeps);
      const skips = await prisma.jackMessage.count({ where: { roomId: room, jobKey: job.key, scheduled: false, content: { startsWith: "Skipped the recurring question" } } });
      check("cap: skipped, with one note for the month", capped.status === "skipped" && skips === 1 && (await notes()).length === 3, capped.summary);
    } finally {
      if (cap === undefined) delete process.env.JACK_AUTOMATION_BUDGET_USD;
      else process.env.JACK_AUTOMATION_BUDGET_USD = cap;
    }

    // ----- the cap's lock: several questions due at once, room for one run -----
    const monthly = process.env.JACK_MONTHLY_BUDGET_USD;
    try {
      const due = [];
      for (const n of [1, 2, 3, 4]) {
        const made = await createRecurringQuestion(
          { title: `Due together ${n} ${tag}`, prompt: `Question ${n} ${tag}?`, roomId: room, persona: "jack", schedule: { every: "week", days: ["mon"], time: "09:00" } },
          { userId: gray.id },
          { enabled: true },
        );
        if (!made.ok) throw new Error(made.error);
        remember("question", made.question.id);
        due.push({ id: made.question.scheduledJobId, key: made.question.scheduledJob.key });
      }
      // Whatever this database has spent or has under way this month, plus half a run: room for one run, not two
      const standing = await automationBudget();
      process.env.JACK_AUTOMATION_BUDGET_USD = String(standing.spentUsd + standing.reservedUsd + typicalRunUsd("jack") / 2);
      process.env.JACK_MONTHLY_BUDGET_USD = "100000";
      // The room run does nothing, so each note asked stays under way (as while Jack is answering it)
      const quiet = { ...runDeps, runRoom: async () => {} };
      const results = await Promise.all(due.map((job) => runRecurringQuestion({ job, startedAt: Date.now(), log: () => {} }, quiet)));
      const asked = await prisma.jackMessage.count({ where: { roomId: room, jobKey: { in: due.map((j) => j.key) }, scheduled: true } });
      check("cap's lock: of four questions due at once with room for one run, exactly one asks", asked === 1 && results.filter((r) => r.status === "skipped").length === 3, results.map((r) => r.summary).join(" | "));
    } finally {
      if (cap === undefined) delete process.env.JACK_AUTOMATION_BUDGET_USD;
      else process.env.JACK_AUTOMATION_BUDGET_USD = cap;
      if (monthly === undefined) delete process.env.JACK_MONTHLY_BUDGET_USD;
      else process.env.JACK_MONTHLY_BUDGET_USD = monthly;
    }

    // ----- pausing itself -----
    await prisma.jackRoom.update({ where: { id: room }, data: { archivedAt: new Date() } });
    const archived = await runRecurringQuestion(ctx(), runDeps);
    const paused = await prisma.recurringQuestion.findUnique({ where: { id: question.id }, include: { scheduledJob: true } });
    check("pause: an archived room pauses it, with the reason", archived.status === "skipped" && paused!.scheduledJob.enabled === false && paused!.pausedReason === "its room is archived");
    await prisma.jackRoom.update({ where: { id: room }, data: { archivedAt: null } });
    await prisma.scheduledJob.update({ where: { id: job.id }, data: { enabled: true } });
    await prisma.recurringQuestion.update({ where: { id: question.id }, data: { createdById: former.id } });
    const orphan = await runRecurringQuestion(ctx(), runDeps);
    const paused2 = await prisma.recurringQuestion.findUnique({ where: { id: question.id }, include: { scheduledJob: true } });
    check("pause: an owner who isn't an officer pauses it", paused2!.scheduledJob.enabled === false && Boolean(paused2!.pausedReason?.includes("isn't an officer any more")), orphan.summary);

    // ----- deleting it -----
    await deleteRecurringQuestion(question.id, { userId: gray.id });
    check("delete: the trigger deletes its job too", (await prisma.scheduledJob.count({ where: { id: job.id } })) === 0);
    remember("question", question.id);

    // ----- recurring.upsert against the real tables -----
    const payload = recurringUpsertSchema.parse({ title: `Proposed ${tag}`, prompt: `Any drafts ${tag}?`, schedule: { every: "weekday", time: "08:30" } });
    const prepared = await recurringUpsertKind.prepare(payload, { roomId: room, officer: { userId: gray.id, displayName: gray.displayName } });
    check("recurring.upsert: prepare describes it with an estimate", prepared.view.summary.includes("a month") && prepared.view.diff.some((row) => row.label === "When" && row.after === "Weekdays at 8:30 AM CT"));
    const applied = await recurringUpsertKind.apply(payload, {
      officer: { userId: gray.id, displayName: gray.displayName },
      proposalId: `check-${tag}`,
      roomId: room,
      idempotencyKey: `proposal:check-${tag}`,
      before: prepared.before,
      auditMetadata: { via: "jack", proposalId: `check-${tag}`, roomId: room, proposedFor: gray.id },
    });
    const createdId = applied.created?.[0]?.id;
    if (createdId) remember("question", createdId);
    const created = createdId ? await prisma.recurringQuestion.findUnique({ where: { id: createdId }, include: { scheduledJob: true } }) : null;
    check("recurring.upsert: apply makes it off, as the officer it was for", created?.scheduledJob.enabled === false && created.createdById === gray.id && created.scheduledJob.schedule === "30 8 * * 1-5");

    // ----- changing someone else's question takes it over -----
    if (createdId) {
      const edited = await updateRecurringQuestion(createdId, { prompt: `Any drafts, by team ${tag}?` }, { userId: dylan.id });
      const owned = await prisma.recurringQuestion.findUnique({ where: { id: createdId } });
      const entry = await prisma.auditLog.findFirst({ where: { entityType: "RECURRING_QUESTION", entityId: createdId, actionType: "UPDATE" }, orderBy: { createdAt: "desc" } });
      check("takeover: another officer rewording it makes them its owner, audited", edited.ok && owned?.createdById === dylan.id && Boolean(entry?.summary.endsWith("and took it over")));
      const renamed = await updateRecurringQuestion(createdId, { title: `Drafts ${tag}` }, { userId: gray.id });
      check("takeover: renaming it doesn't", renamed.ok && (await prisma.recurringQuestion.findUnique({ where: { id: createdId } }))?.createdById === dylan.id);
      // Proposed for Gray, applied by Dylan: Gray asked for the wording, so it's asked as Gray
      const change = recurringUpsertSchema.parse({ id: createdId, prompt: `Any drafts this week ${tag}?` });
      const proposed = await recurringUpsertKind.prepare(change, { roomId: room, officer: { userId: gray.id, displayName: gray.displayName } });
      check("takeover: the change's card says who it'll be asked as", proposed.view.diff.some((row) => row.label === "Asked as" && row.after === gray.displayName));
      await recurringUpsertKind.apply(change, {
        officer: { userId: dylan.id, displayName: dylan.displayName },
        proposalId: `check-edit-${tag}`,
        roomId: room,
        idempotencyKey: `proposal:check-edit-${tag}`,
        before: proposed.before,
        auditMetadata: { via: "jack", proposalId: `check-edit-${tag}`, roomId: room, proposedFor: gray.id },
      });
      check("takeover: a proposal's change goes to the officer it was for, whoever applies it", (await prisma.recurringQuestion.findUnique({ where: { id: createdId } }))?.createdById === gray.id);
    }

    // ----- the weekly digest -----
    const report = await runDigestChecks();
    const broken = failedChecks(report);
    check(`digest: all ${report.outcomes.length} checks run against this database`, broken.length === 0, broken.map((o) => `${o.check.id}: ${o.error}`).join("; "));
    const digestDeps = { ...defaultDigestRunDeps, broadcast: async () => {}, runRoom: runDeps.runRoom, discord: async () => null, teams: async () => null };
    const digestCtx = { config: { roomId: room, summary: true, discordChannelId: null, teams: false, configuredById: gray.id, configuredAt: null }, job: { id: `no-job-${tag}`, key: "digest.weekly" }, startedAt: Date.now(), log: () => {}, signal: new AbortController().signal };
    const digest = await runWeeklyDigest(digestCtx, digestDeps);
    const [digestNote] = await prisma.jackMessage.findMany({ where: { roomId: room, jobKey: "digest.weekly" }, include: { answeredBy: true } });
    const asked = digestNote?.scheduled === true;
    check("digest: the note is in the room, set up by its owner", Boolean(digestNote?.content.startsWith("Weekly digest for ") && digestNote.content.includes(`(set up by ${gray.displayName})`)), digest.summary);
    check("digest: Jack sums it up when there's something to sum up", asked ? digestNote!.answeredBy?.persona === "jack" : !digestNote?.content.includes("Jack: sum this up"));
    const again = await runWeeklyDigest(digestCtx, digestDeps);
    check("digest: once a day", (await prisma.jackMessage.count({ where: { roomId: room, jobKey: "digest.weekly" } })) === 1 && again.summary.includes("already posted today"));
  } finally {
    await cleanup(prisma, ids, tag);
  }
}

/** Deletes everything the run made: audit entries, the rooms (messages, questions and, by the trigger, their jobs go with them), any job left, then the people */
async function cleanup(prisma: (typeof import("../src/server/db"))["prisma"], ids: Record<string, string[]>, tag: string) {
  const questions = ids.question ?? [];
  const steps: [string, () => Promise<unknown>][] = [
    ["audit entries", () => prisma.auditLog.deleteMany({ where: { OR: [{ entityType: "RECURRING_QUESTION", entityId: { in: questions } }, { actorUserId: { in: ids.user ?? [] } }] } })],
    ["rooms", () => prisma.jackRoom.deleteMany({ where: { id: { in: ids.room ?? [] } } })],
    ["jobs", () => prisma.scheduledJob.deleteMany({ where: { key: { in: questions.map((id) => `recurring:${id}`) } } })],
    ["people", () => prisma.user.deleteMany({ where: { id: { in: ids.user ?? [] } } })],
  ];
  for (const [what, step] of steps) {
    try {
      await step();
    } catch (error) {
      failed = true;
      console.error(`FAIL  cleanup: couldn't delete the ${what} (tag ${tag}):`, error instanceof Error ? error.message : error);
    }
  }
  const left = (await prisma.jackMessage.count({ where: { content: { contains: tag } } })) + (await prisma.recurringQuestion.count({ where: { title: { contains: tag } } }));
  check("cleanup: nothing left behind", left === 0);
  await prisma.$disconnect();
}

main()
  .catch((error) => {
    failed = true;
    console.error(error);
  })
  .finally(() => {
    console.log(failed ? "\nSome checks FAILED." : "\nAll checks passed.");
    process.exit(failed ? 1 : 0);
  });
