/**
 * Checks the rooms work from the decks-rooms track (#188, design §10) against the LOCAL database: what
 * unit tests can't, because it lives in Postgres.
 *
 *   - mention mode through the real reply loop: an aside starts no reply and waits for none; the next
 *     mention's reply takes it as context (the relation filter on the room, expectsAnswer)
 *   - archived rooms: no posts, nothing answered (a message left waiting stays waiting until the room is
 *     unarchived), the snapshot still loads, the lists and the list's search
 *   - pins: a pinned room sorts before every unpinned one
 *   - ratings: one per officer per reply (the unique key), changed, taken back
 *   - the Usage page's queries: the raw month SQL (Central Time buckets, a reply at 11:30 PM on the
 *     last day of a month counts in that month), who each reply's cost goes to, the month's ratings and
 *     first questions. In February 2001, where nothing else is
 *
 *   cd apps/platform
 *   NODE_ENV=production pnpm exec tsx scripts/check-jack-rooms.ts
 *
 * Refuses to run unless DATABASE_URL points at 127.0.0.1 or localhost. It never calls Claude (replies
 * are the "isn't connected" notice) and never broadcasts. It writes only rows it creates (tagged with one
 * random word) and deletes them at the end, pass or fail.
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
  const { countArchivedRooms, getRoomSnapshot, listRooms, postOfficerMessage } = await import("../src/server/jack/rooms");
  const { runRoom } = await import("../src/server/jack/reply-loop");
  const { setRoomAnswerMode, setRoomArchived, setRoomPinned } = await import("../src/server/jack/room-settings");
  const { roomFeedback, setReplyFeedback } = await import("../src/server/jack/feedback");
  const { searchRooms } = await import("../src/server/jack/room-search");
  const { feedbackForMonth, firstQuestions, monthFromKey, monthlyCosts, spendBySource } = await import("../src/server/jack/usage");

  const tag = `zq${randomBytes(5).toString("hex")}`;
  const ids: Record<string, string[]> = {};
  const remember = (table: string, id: string) => {
    (ids[table] ??= []).push(id);
    return id;
  };
  console.log(`Tag: ${tag}`);

  // Replies without Claude: the reply loop runs for real and writes the "isn't connected" notice
  const quiet = { broadcast: async () => {}, getClient: () => null, tools: [], budget: async () => ({ month: "February", spentUsd: 0, budgetUsd: 50 }) };
  const silent = async () => {};

  try {
    const person = async (key: string) => {
      const user = await prisma.user.create({ data: { email: `${tag}-${key}@example.test`, handle: `${tag}-${key}`, displayName: `Check ${key} ${tag}` } });
      remember("user", user.id);
      return { id: user.id, displayName: user.displayName };
    };
    const gray = await person("gray");
    const dylan = await person("dylan");
    const room = remember("room", (await prisma.jackRoom.create({ data: { title: `Rooms check ${tag}`, createdById: gray.id } })).id);
    const repliesIn = (roomId: string) => prisma.jackMessage.findMany({ where: { roomId, kind: "assistant" }, orderBy: { createdAt: "asc" } });

    // ----- mention mode -----
    const set = await setRoomAnswerMode(room, gray, "mention", silent);
    check("mention mode: switched, with a note", set?.changed === true && set.message?.content === `${gray.displayName} set this room to answer only messages that mention @Jack`);
    const aside = await postOfficerMessage(room, gray.id, `Should GM 2 move to Thursday ${tag}?`, { replyDeps: quiet });
    check("mention mode: an aside expects no answer", aside?.expectsAnswer === false);
    check("mention mode: an aside starts no reply", (await repliesIn(room)).length === 0);
    const mention = await postOfficerMessage(room, dylan.id, `@jack how many registered for GM 2 ${tag}?`, { replyDeps: quiet });
    const [reply] = await repliesIn(room);
    const answered = await prisma.jackMessage.findMany({ where: { id: { in: [aside!.id, mention!.id] } }, select: { answeredById: true } });
    check("mention mode: the mention got a reply that took the aside as context", Boolean(reply) && answered.every((m) => m.answeredById === reply.id));

    // ----- archived rooms -----
    const archived = await setRoomArchived(room, gray, true, silent);
    check("archive: archived, with a note", archived?.changed === true && archived.message?.content === `${gray.displayName} archived this room`);
    check("archive: no posts", (await postOfficerMessage(room, gray.id, `Anyone ${tag}?`, { replyDeps: quiet })) === null);
    const waiting = await prisma.jackMessage.create({ data: { roomId: room, kind: "user", authorUserId: dylan.id, content: `Left waiting ${tag}` } });
    await runRoom(room, quiet);
    const lock = await prisma.jackRoom.findUnique({ where: { id: room }, select: { runId: true } });
    check("archive: a run answers nothing and lets go of the lock", (await repliesIn(room)).length === 1 && lock?.runId === null);
    const snapshot = await getRoomSnapshot(room, { viewerId: gray.id });
    check("archive: the snapshot still loads, saying it's archived", Boolean(snapshot?.room.archivedAt) && snapshot!.room.answerMode === "mention");
    check("archive: in the archived list, out of the other", (await listRooms({ archived: true })).some((r) => r.id === room) && !(await listRooms()).some((r) => r.id === room) && (await countArchivedRooms()) >= 1);
    const found = await searchRooms(tag);
    check("archive: the list's search finds the room and its messages, marked", found.rooms.some((r) => r.id === room && r.archivedAt) && found.messages.some((m) => m.roomId === room && m.roomArchived));
    check("archive: no pin while archived", (await setRoomPinned(room, true, silent)) === null);
    await setRoomArchived(room, dylan, false, silent);
    await runRoom(room, quiet);
    const afterUnarchive = await prisma.jackMessage.findUnique({ where: { id: waiting.id }, select: { answeredById: true } });
    check("unarchive: what was left waiting is answered by the next run", (await repliesIn(room)).length === 2 && afterUnarchive?.answeredById !== null);

    // ----- pins -----
    await setRoomPinned(room, true, silent);
    const list = await listRooms();
    const firstUnpinned = list.findIndex((r) => !r.pinnedAt);
    const at = list.findIndex((r) => r.id === room);
    check("pins: a pinned room sorts before every unpinned one", at >= 0 && (firstUnpinned === -1 || at < firstUnpinned), `at ${at}, first unpinned ${firstUnpinned}`);

    // ----- ratings -----
    const first = await setReplyFeedback({ messageId: reply.id, userId: gray.id, rating: "down", note: `Wrong date ${tag}` });
    const changed = await setReplyFeedback({ messageId: reply.id, userId: gray.id, rating: "up", note: null });
    await setReplyFeedback({ messageId: reply.id, userId: dylan.id, rating: "down", note: null });
    const rows = await prisma.jackFeedback.count({ where: { messageId: reply.id } });
    const summaries = await roomFeedback(room, gray.id);
    check("ratings: one per officer per reply, changeable", first.ok && changed.ok && rows === 2 && summaries[reply.id]?.up === 1 && summaries[reply.id]?.down === 1 && summaries[reply.id]?.mine?.rating === "up");
    await setReplyFeedback({ messageId: reply.id, userId: dylan.id, rating: null, note: null });
    check("ratings: taken back", (await prisma.jackFeedback.count({ where: { messageId: reply.id } })) === 1);
    const onQuestion = await setReplyFeedback({ messageId: mention!.id, userId: gray.id, rating: "up", note: null });
    check("ratings: only on replies", !onQuestion.ok);

    // ----- the Usage page, in February 2001 -----
    const month = monthFromKey("2001-02")!;
    const day = (iso: string) => new Date(iso);
    const old = remember("room", (await prisma.jackRoom.create({ data: { title: `Usage check ${tag}`, createdById: gray.id, createdAt: day("2001-02-10T18:00:00Z") } })).id);
    const question = await prisma.jackMessage.create({ data: { roomId: old, kind: "user", authorUserId: gray.id, content: `How many members paid ${tag}?`, createdAt: day("2001-02-10T18:00:00Z") } });
    const paid = await prisma.jackMessage.create({ data: { roomId: old, kind: "assistant", persona: "jack", model: "claude-sonnet-5-5", content: `Twelve ${tag}`, costUsd: 0.5, createdAt: day("2001-02-10T18:00:05Z") } });
    await prisma.jackMessage.update({ where: { id: question.id }, data: { answeredById: paid.id } });
    const note = await prisma.jackMessage.create({ data: { roomId: old, kind: "system", scheduled: true, authorUserId: gray.id, content: `Recurring question ${tag}`, createdAt: day("2001-02-11T18:00:00Z") } });
    const recurring = await prisma.jackMessage.create({ data: { roomId: old, kind: "assistant", persona: "lift", model: "claude-opus-5-5", content: "Weekly answer", costUsd: 0.25, createdAt: day("2001-02-11T18:00:05Z") } });
    await prisma.jackMessage.update({ where: { id: note.id }, data: { answeredById: recurring.id } });
    // 11:30 PM CST on Feb 28: still February in Central Time, March in UTC
    const lateQuestion = await prisma.jackMessage.create({ data: { roomId: old, kind: "user", authorUserId: dylan.id, content: "Late one", createdAt: day("2001-03-01T05:29:00Z") } });
    const late = await prisma.jackMessage.create({ data: { roomId: old, kind: "assistant", persona: "jack", model: "claude-sonnet-5-5", content: "Late answer", costUsd: 0.04, createdAt: day("2001-03-01T05:30:00Z") } });
    await prisma.jackMessage.update({ where: { id: lateQuestion.id }, data: { answeredById: late.id } });
    remember("usage", (await prisma.jackUsage.create({ data: { roomId: old, persona: "stand", job: "name_room", outcome: "named", model: "claude-haiku-5-5", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, costUsd: 0.01, createdAt: day("2001-02-12T18:00:00Z") } })).id);
    await prisma.jackFeedback.create({ data: { messageId: paid.id, userId: dylan.id, rating: "down", note: `Wrong count ${tag}`, createdAt: day("2001-02-13T18:00:00Z") } });

    const [costs] = await monthlyCosts([month]);
    check("usage: the month adds up replies and side jobs by persona, by Central Time", costs.totalUsd === 0.8 && costs.replies === 3 && costs.byPersona.jack === 0.54 && costs.byPersona.lift === 0.25 && costs.byPersona.stand === 0.01, JSON.stringify(costs));
    const spenders = await spendBySource(month);
    const of = (key: string) => spenders.find((s) => s.key === key);
    check("usage: each reply goes to the officer who started it, the recurring one to automation, naming to side jobs", of(`officer:${gray.id}`)?.costUsd === 0.5 && of(`officer:${dylan.id}`)?.costUsd === 0.04 && of("automation:recurring")?.costUsd === 0.25 && of("side:name_room")?.costUsd === 0.01, JSON.stringify(spenders));
    const ratings = await feedbackForMonth(month);
    check("usage: the month's thumbs-down, with its note and question", ratings.counts.down === 1 && ratings.counts.notes === 1 && ratings.down[0]?.note === `Wrong count ${tag}` && ratings.down[0]?.question === `How many members paid ${tag}?`);
    const questions = await firstQuestions(month);
    check("usage: the room's first question", questions.some((q) => q.id === old && q.question === `How many members paid ${tag}?`));
  } finally {
    await cleanup(prisma, ids, tag);
  }
}

/** Deletes everything the run made: side jobs, then the rooms (their messages and ratings go with them), then the people */
async function cleanup(prisma: (typeof import("../src/server/db"))["prisma"], ids: Record<string, string[]>, tag: string) {
  const steps: [string, () => Promise<unknown>][] = [
    ["side jobs", () => prisma.jackUsage.deleteMany({ where: { id: { in: ids.usage ?? [] } } })],
    ["rooms", () => prisma.jackRoom.deleteMany({ where: { id: { in: ids.room ?? [] } } })],
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
  const left = await prisma.jackMessage.count({ where: { content: { contains: tag } } });
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
