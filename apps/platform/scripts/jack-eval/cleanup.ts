/**
 * Every question runs in a room of its own, and afterwards everything it made there is undone (design
 * §16): proposals and anything they led to, knowledge entries, room files and their stored objects,
 * recurring questions, meetings and action items, decks, the DRAFT events Jack drafted, and the audit
 * entries his tools wrote. Eval rooms are found by id (`jack-eval-…`; real rooms have uuids), so a run
 * that was killed is cleaned up by the next one.
 *
 * What the eval's replies write, and how it's found again:
 * - by room: JackProposal, JackFile (and its stored objects), RecurringQuestion (and its ScheduledJob),
 *   Meeting, ActionItem, JackDeck, JackUsage, and KnowledgeEntryVersion.roomId (Jack's knowledge saves
 *   record the room);
 * - through a room's proposals: DiscordPost and InstagramPublish rows (`proposalId`);
 * - through audit entries naming the room (`metadata.roomId`): events draft_event created, and
 *   knowledge entries saved, updated or archived. A knowledge entry the eval created goes with every
 *   audit entry about it, whatever room (if any) that names.
 * A track whose tool writes anything else must make it findable one of these ways.
 *
 * Knowledge versions, action items and audit entries keep a plain room id (no foreign key), so a write
 * that lands after its room was cleaned up is found by that id instead (orphanedEvalRooms).
 */
import { EVAL_ROOM_PREFIX } from "../../src/server/jack/eval-support";
import { filePaths, storedPaths } from "../../src/server/jack/files/paths";
import type { EvalContext } from "./shared";

type Db = EvalContext["prisma"];

/** Every eval room's id starts with this; real rooms have uuids */
export { EVAL_ROOM_PREFIX };
/** Before 2.0 every question's tools ran with this room id, which has no JackRoom row; drafts made then are still found by it */
export const LEGACY_EVAL_ROOM_ID = "jack-eval";

/** A run's tag: its rooms' ids start with `jack-eval-<tag>-` */
export const runTag = (startedAt: Date) => startedAt.getTime().toString(36);

/** A fresh room id for one question on one model in one run */
export function evalRoomId(run: string, questionId: string, persona: string): string {
  const slug = questionId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${EVAL_ROOM_PREFIX}${run}-${persona}-${slug}-${Math.random().toString(36).slice(2, 6)}`;
}

export const isEvalRoomId = (id: string) => id === LEGACY_EVAL_ROOM_ID || id.startsWith(EVAL_ROOM_PREFIX);

/** What a cleanup removed, and what it left for a person to look at */
export type CleanupReport = {
  rooms: number;
  proposals: number;
  discordPosts: number;
  instagramPublishes: number;
  events: number;
  knowledgeDeleted: number;
  knowledgeRestored: number;
  files: number;
  storageObjects: number;
  recurringQuestions: number;
  meetings: number;
  actionItems: number;
  decks: number;
  usageRows: number;
  auditEntries: number;
  /** Left in place on purpose (a post that went out, a stored object with no way to delete it): look at these */
  left: string[];
  /** Steps that failed; the rest still ran */
  errors: string[];
};

export type CleanupOptions = {
  /**
   * Deletes stored objects (room files' originals, model copies and thumbnails), as the file store's
   * delete does: paths that aren't there are fine. Without it they're listed in `left`
   */
  deleteObjects?: (paths: string[]) => Promise<void>;
  /** Deletes a Claude Files API file. Without it they're listed in `left` */
  deleteClaudeFile?: (id: string) => Promise<void>;
};

/** Cleanup that deletes stored objects through a file store: the eval passes the app's (jackFileStore()) */
export function fileStoreCleanup(store: { delete(paths: string[]): Promise<void> }): CleanupOptions {
  return { deleteObjects: (paths) => store.delete(paths) };
}

const emptyReport = (): CleanupReport => ({
  rooms: 0,
  proposals: 0,
  discordPosts: 0,
  instagramPublishes: 0,
  events: 0,
  knowledgeDeleted: 0,
  knowledgeRestored: 0,
  files: 0,
  storageObjects: 0,
  recurringQuestions: 0,
  meetings: 0,
  actionItems: 0,
  decks: 0,
  usageRows: 0,
  auditEntries: 0,
  left: [],
  errors: [],
});

/** One line for the log, or null when there was nothing to clean up */
export function describeCleanup(report: CleanupReport): string | null {
  const counts: [number, string, string][] = [
    [report.rooms, "room", "rooms"],
    [report.proposals, "proposal", "proposals"],
    [report.discordPosts, "Discord post", "Discord posts"],
    [report.instagramPublishes, "Instagram publish", "Instagram publishes"],
    [report.events, "draft event", "draft events"],
    [report.knowledgeDeleted, "knowledge entry deleted", "knowledge entries deleted"],
    [report.knowledgeRestored, "knowledge entry restored", "knowledge entries restored"],
    [report.files, "file", "files"],
    [report.storageObjects, "stored object", "stored objects"],
    [report.recurringQuestions, "recurring question", "recurring questions"],
    [report.meetings, "meeting", "meetings"],
    [report.actionItems, "action item", "action items"],
    [report.decks, "deck", "decks"],
    [report.usageRows, "usage row", "usage rows"],
    [report.auditEntries, "audit entry", "audit entries"],
  ];
  const done = counts.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  const extra = [...report.left.map((l) => `left: ${l}`), ...report.errors.map((e) => `failed: ${e}`)];
  return done.length || extra.length ? [done.join(", "), ...extra].filter(Boolean).join("; ") : null;
}

type KnowledgeVersion = { id: string; roomId: string | null; title: string; body: string; tags: string[]; createdAt: Date };
type KnowledgeRow = { id: string; createdAt: Date; archivedAt: Date | null; provenance: unknown; versions: KnowledgeVersion[] };

export type KnowledgePlan = {
  /** Entries the eval created: deleted with their versions */
  remove: string[];
  /**
   * Entries that existed before: put back as their newest version from outside the eval (when there's
   * one: no content means nothing to put back), losing the eval's versions, and unarchived if the eval
   * archived them
   */
  restore: { id: string; content?: { title: string; body: string; tags: string[] }; unarchive: boolean; dropVersions: string[] }[];
  /** Entries left alone that a person should look at */
  left: string[];
};

/** Room times come from the database's clock and archive times from the app's: allow for them differing a little */
const CLOCK_SKEW_MS = 60_000;

/**
 * What to do with the knowledge entries eval rooms touched, given `since` (when the eval's rooms were
 * made, less a minute for clock skew). An entry made after `since` whose first version was saved in an
 * eval room (or, with no versions, whose provenance names one) is the eval's: delete it. Any other entry
 * existed before: it goes back to its newest version saved anywhere else, losing the eval's versions, and
 * is unarchived when it was archived after `since`. With no `since`, nothing is deleted
 */
export function knowledgePlan(entries: KnowledgeRow[], roomIds: string[], since: Date | null): KnowledgePlan {
  const evalRoom = (roomId: string | null) => roomId !== null && roomIds.includes(roomId);
  const after = since ? new Date(since.getTime() - CLOCK_SKEW_MS) : null;
  const plan: KnowledgePlan = { remove: [], restore: [], left: [] };
  for (const entry of entries) {
    const versions = [...entry.versions].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const provenance = entry.provenance === null || entry.provenance === undefined ? "" : JSON.stringify(entry.provenance);
    const startedHere = versions.length ? evalRoom(versions[0].roomId) : roomIds.some((id) => provenance.includes(`"${id}"`));
    // An entry older than the eval's rooms with no history before the eval's edit is restored, not deleted
    if (startedHere && after && entry.createdAt >= after) {
      plan.remove.push(entry.id);
      continue;
    }
    if (startedHere && !after) plan.left.push(`knowledge entry ${entry.id} was saved in an eval room, but when the room was made is unknown: left in place`);
    const dropVersions = versions.filter((v) => evalRoom(v.roomId)).map((v) => v.id);
    const keep = versions.filter((v) => !evalRoom(v.roomId)).at(-1);
    const unarchive = Boolean(entry.archivedAt && after && entry.archivedAt >= after);
    if (!dropVersions.length && !unarchive) continue;
    plan.restore.push({ id: entry.id, ...(dropVersions.length && keep ? { content: { title: keep.title, body: keep.body, tags: keep.tags } } : {}), unarchive, dropVersions });
  }
  return plan;
}

/** What a person should check about an entry the cleanup restored */
function restoredNote(entry: KnowledgePlan["restore"][number]): string {
  if (entry.content) return `knowledge entry ${entry.id} existed before the eval changed it: restored its last version; check its reviewed status`;
  if (entry.dropVersions.length) return `knowledge entry ${entry.id} existed before the eval changed it, with no earlier version to restore: it keeps the eval's text; check it`;
  return `knowledge entry ${entry.id} existed before the eval archived it: unarchived it; check its reviewed status`;
}

const SENT_POSTS = ["SENT", "SENDING"];
const SENT_PUBLISHES = ["publishing", "published"];

/**
 * Undoes everything made in these eval rooms, then deletes the rooms. Each step runs even when an
 * earlier one failed (a failure is reported, not thrown), and nothing outside the eval rooms is
 * touched except what they led to: a Discord post or Instagram publish from one of their proposals,
 * or an event or knowledge entry an audit entry from one of them names.
 */
export async function cleanUpEvalRooms(prisma: Db, roomIds: string[], options: CleanupOptions = {}): Promise<CleanupReport> {
  const report = emptyReport();
  const ids = [...new Set(roomIds)].filter(isEvalRoomId);
  if (!ids.length) return report;
  const step = async (what: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      report.errors.push(`${what}: ${error instanceof Error ? error.message.split("\n").filter(Boolean).at(-1) : String(error)}`);
    }
  };

  /** When the rooms were made; for rooms already gone, when the eval first wrote anything naming them */
  let since: Date | null = null;
  const earliest = (dates: Date[]) => dates.reduce<Date | null>((min, at) => (!min || at < min ? at : min), null);
  let proposalIds: string[] = [];
  let audits: { id: string; actionType: string; entityType: string; entityId: string; createdAt: Date }[] = [];

  await step("rooms", async () => {
    since = earliest((await prisma.jackRoom.findMany({ where: { id: { in: ids } }, select: { createdAt: true } })).map((r) => r.createdAt));
  });
  await step("proposals", async () => {
    proposalIds = (await prisma.jackProposal.findMany({ where: { roomId: { in: ids } }, select: { id: true } })).map((p) => p.id);
    report.proposals = proposalIds.length;
  });
  await step("audit entries", async () => {
    audits = await prisma.auditLog.findMany({
      where: { OR: ids.map((id) => ({ metadata: { path: ["roomId"], equals: id } })) },
      select: { id: true, actionType: true, entityType: true, entityId: true, createdAt: true },
    });
  });

  if (proposalIds.length) {
    await step("Discord posts", async () => {
      const posts = await prisma.discordPost.findMany({ where: { proposalId: { in: proposalIds } }, select: { id: true, status: true } });
      const sent = posts.filter((p) => SENT_POSTS.includes(p.status));
      for (const post of sent) report.left.push(`Discord post ${post.id} from an eval proposal is ${post.status}: check Discord`);
      const unsent = posts.filter((p) => !SENT_POSTS.includes(p.status)).map((p) => p.id);
      if (unsent.length) report.discordPosts = (await prisma.discordPost.deleteMany({ where: { id: { in: unsent } } })).count;
    });
    await step("Instagram publishes", async () => {
      const publishes = await prisma.instagramPublish.findMany({ where: { proposalId: { in: proposalIds } }, select: { id: true, status: true } });
      for (const p of publishes.filter((p) => SENT_PUBLISHES.includes(p.status))) report.left.push(`Instagram publish ${p.id} from an eval proposal is ${p.status}: check Instagram`);
      const unsent = publishes.filter((p) => !SENT_PUBLISHES.includes(p.status)).map((p) => p.id);
      if (unsent.length) report.instagramPublishes = (await prisma.instagramPublish.deleteMany({ where: { id: { in: unsent } } })).count;
    });
  }

  await step("draft events", async () => {
    // Only events Jack created (draft_event); an audit entry about a change to an existing event never deletes it
    const drafted = audits.filter((a) => a.entityType === "EVENT" && a.actionType === "CREATE").map((a) => a.entityId);
    if (drafted.length) report.events = (await prisma.event.deleteMany({ where: { id: { in: drafted }, status: "DRAFT" } })).count;
  });

  await step("knowledge", async () => {
    const saved = await prisma.knowledgeEntryVersion.findMany({ where: { roomId: { in: ids } }, select: { entryId: true, createdAt: true } });
    const touched = new Set(saved.map((v) => v.entryId));
    for (const a of audits) touched.add(a.entityId);
    if (!touched.size) return;
    // Rooms already gone (a write that landed after its room's cleanup): the eval's first write naming them stands in for when they were made
    since ??= earliest([...saved, ...audits].map((row) => row.createdAt));
    const entries = await prisma.knowledgeEntry.findMany({
      where: { id: { in: [...touched] } },
      select: { id: true, createdAt: true, archivedAt: true, provenance: true, versions: { select: { id: true, roomId: true, title: true, body: true, tags: true, createdAt: true } } },
    });
    const plan = knowledgePlan(entries, ids, since);
    report.left.push(...plan.left);
    if (plan.remove.length) {
      // Versions go with them (cascade). Their audit entries too: the ones naming these rooms are deleted
      // below with the rest; any other (an officer reviewing one during the run) is about an entry that's gone
      report.knowledgeDeleted = (await prisma.knowledgeEntry.deleteMany({ where: { id: { in: plan.remove } } })).count;
      const others = await prisma.auditLog.deleteMany({ where: { entityType: "KNOWLEDGE_ENTRY", entityId: { in: plan.remove }, id: { notIn: audits.map((a) => a.id) } } });
      report.auditEntries += others.count;
    }
    for (const entry of plan.restore) {
      if (entry.content || entry.unarchive) await prisma.knowledgeEntry.update({ where: { id: entry.id }, data: { ...entry.content, ...(entry.unarchive ? { archivedAt: null } : {}) } });
      if (entry.dropVersions.length) await prisma.knowledgeEntryVersion.deleteMany({ where: { id: { in: entry.dropVersions } } });
      report.knowledgeRestored++;
      report.left.push(restoredNote(entry));
    }
  });

  await step("files", async () => {
    const files = await prisma.jackFile.findMany({
      where: { roomId: { in: ids } },
      select: { id: true, roomId: true, storagePath: true, modelCopyPath: true, thumbPath: true, anthropicFileId: true },
    });
    report.files = files.length;
    const recorded = files.flatMap(storedPaths);
    const some = (paths: string[]) => `${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ", ..." : ""}`;
    if (recorded.length && !options.deleteObjects) report.left.push(`${recorded.length} stored file object(s) (no way to delete them): ${some(recorded)}`);
    // Photo copies too, recorded or not, as the file cleanup job does: registration stores them before it records them
    const paths = [...new Set(files.flatMap((f) => [...storedPaths(f), ...filePaths(f)]))];
    if (options.deleteObjects && paths.length) {
      try {
        await options.deleteObjects(paths);
        report.storageObjects = recorded.length;
      } catch (error) {
        report.left.push(`${recorded.length} stored file object(s) (${error instanceof Error ? error.message : String(error)}): ${some(recorded)}`);
      }
    }
    for (const id of files.flatMap((f) => (f.anthropicFileId ? [f.anthropicFileId] : []))) {
      if (!options.deleteClaudeFile) {
        report.left.push(`Claude file ${id}`);
        continue;
      }
      await options.deleteClaudeFile(id).catch((error) => report.left.push(`Claude file ${id}: ${error instanceof Error ? error.message : String(error)}`));
    }
  });

  await step("recurring questions", async () => {
    // Deleting the job deletes its question (and the room would too, with the job going by trigger)
    const questions = await prisma.recurringQuestion.findMany({ where: { roomId: { in: ids } }, select: { scheduledJobId: true } });
    if (questions.length) {
      await prisma.scheduledJob.deleteMany({ where: { id: { in: questions.map((q) => q.scheduledJobId) } } });
      report.recurringQuestions = questions.length;
    }
  });

  await step("meetings and action items", async () => {
    const meetings = (await prisma.meeting.findMany({ where: { roomId: { in: ids } }, select: { id: true } })).map((m) => m.id);
    // Action items and decisions first: deleting a meeting only unlinks them (SetNull)
    report.actionItems = (await prisma.actionItem.deleteMany({ where: { OR: [{ roomId: { in: ids } }, ...(meetings.length ? [{ meetingId: { in: meetings } }] : [])] } })).count;
    if (meetings.length) {
      await prisma.meetingDecision.deleteMany({ where: { meetingId: { in: meetings } } });
      report.meetings = (await prisma.meeting.deleteMany({ where: { id: { in: meetings } } })).count;
    }
  });

  await step("decks", async () => {
    report.decks = (await prisma.jackDeck.deleteMany({ where: { roomId: { in: ids } } })).count;
  });
  await step("usage rows", async () => {
    report.usageRows = (await prisma.jackUsage.deleteMany({ where: { roomId: { in: ids } } })).count;
  });
  await step("audit entries", async () => {
    if (audits.length) report.auditEntries += (await prisma.auditLog.deleteMany({ where: { id: { in: audits.map((a) => a.id) } } })).count;
  });
  // Last: messages, proposals, files, recurring questions and feedback go with their room
  await step("rooms", async () => {
    report.rooms = (await prisma.jackRoom.deleteMany({ where: { id: { in: ids } } })).count;
  });
  return report;
}

/**
 * Eval rooms a killed run left behind: older than `olderThan`, so a run going on at the same time on
 * the same database keeps its rooms. The pre-2.0 room id is always included (it has no room row)
 */
export async function leftoverEvalRooms(prisma: Db, olderThan: Date): Promise<string[]> {
  const rooms = await prisma.jackRoom.findMany({ where: { id: { startsWith: EVAL_ROOM_PREFIX }, createdAt: { lt: olderThan } }, select: { id: true } });
  return [LEGACY_EVAL_ROOM_ID, ...rooms.map((r) => r.id)];
}

/** This run's rooms that are still there (a question whose own cleanup failed) */
export async function runRooms(prisma: Db, tag: string): Promise<string[]> {
  return (await prisma.jackRoom.findMany({ where: { id: { startsWith: `${EVAL_ROOM_PREFIX}${tag}-` } }, select: { id: true } })).map((r) => r.id);
}

/**
 * Eval rooms that are gone but still named by a write: knowledge versions, action items and audit
 * entries keep a plain room id, so a tool that finished after its question's cleanup (a reply stopped at
 * the time limit, say) leaves rows that only these ids find. cleanUpEvalRooms takes them like any room.
 * The eval runs it before and after a run
 */
export async function orphanedEvalRooms(prisma: Db): Promise<string[]> {
  const prefix = { startsWith: EVAL_ROOM_PREFIX };
  const [versions, items, audits] = await Promise.all([
    prisma.knowledgeEntryVersion.findMany({ where: { roomId: prefix }, select: { roomId: true }, distinct: ["roomId"] }),
    prisma.actionItem.findMany({ where: { roomId: prefix }, select: { roomId: true }, distinct: ["roomId"] }),
    prisma.$queryRaw<{ roomId: string }[]>`SELECT DISTINCT "metadata"->>'roomId' AS "roomId" FROM "AuditLog" WHERE "metadata"->>'roomId' LIKE ${`${EVAL_ROOM_PREFIX}%`}`,
  ]);
  const named = [...new Set([...versions, ...items, ...audits].flatMap((row) => (row.roomId ? [row.roomId] : [])))];
  if (!named.length) return [];
  const live = new Set((await prisma.jackRoom.findMany({ where: { id: { in: named } }, select: { id: true } })).map((r) => r.id));
  return named.filter((id) => !live.has(id));
}
