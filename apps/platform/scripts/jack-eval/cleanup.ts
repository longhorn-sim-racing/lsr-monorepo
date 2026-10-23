/**
 * Every question runs in a room of its own, and afterwards everything it made there is undone (design
 * §16): proposals and anything they led to, knowledge entries, room files and their stored objects,
 * recurring questions, meetings and action items, decks, the DRAFT events Jack drafted, and the audit
 * entries his tools wrote. Eval rooms are found by id (`jack-eval-…`; real rooms have uuids), so a run
 * that was killed is cleaned up by the next one.
 *
 * What the eval's replies write, and how it's found again:
 * - by room: JackProposal, JackFile, RecurringQuestion (and its ScheduledJob), Meeting, ActionItem,
 *   JackDeck, JackUsage, and KnowledgeEntryVersion.roomId (Jack's knowledge saves record the room);
 * - through a room's proposals: DiscordPost and InstagramPublish rows (`proposalId`);
 * - through audit entries naming the room (`metadata.roomId`): events draft_event created, and
 *   knowledge entries archived.
 * A track whose tool writes anything else must make it findable one of these ways.
 */
import type { EvalContext } from "./shared";

type Db = EvalContext["prisma"];

/** Every eval room's id starts with this; real rooms have uuids */
export const EVAL_ROOM_PREFIX = "jack-eval-";
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
  /** Deletes one stored object (a room file's original, model copy or thumbnail). Without it they're listed in `left` */
  deleteObject?: (path: string) => Promise<void>;
  /** Deletes a Claude Files API file. Without it they're listed in `left` */
  deleteClaudeFile?: (id: string) => Promise<void>;
};

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
  /** Entries that existed before: put back as their newest version from outside the eval, and unarchived if the eval archived them */
  restore: { id: string; content?: { title: string; body: string; tags: string[] }; unarchive: boolean; dropVersions: string[] }[];
};

/** Room times come from the database's clock and archive times from the app's: allow for them differing a little */
const CLOCK_SKEW_MS = 60_000;

/**
 * What to do with the knowledge entries eval rooms touched. An entry whose first version was saved in an
 * eval room (or, with no versions, whose provenance names one) is the eval's: delete it. One that existed
 * before goes back to its newest version saved anywhere else, losing the eval's versions, and is unarchived
 * when it was archived after `since` (when the eval's rooms were made, less a minute for clock skew)
 */
export function knowledgePlan(entries: KnowledgeRow[], roomIds: string[], since: Date | null): KnowledgePlan {
  const evalRoom = (roomId: string | null) => roomId !== null && roomIds.includes(roomId);
  const archivedSince = since ? new Date(since.getTime() - CLOCK_SKEW_MS) : null;
  const plan: KnowledgePlan = { remove: [], restore: [] };
  for (const entry of entries) {
    const versions = [...entry.versions].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const provenance = entry.provenance === null || entry.provenance === undefined ? "" : JSON.stringify(entry.provenance);
    const createdHere = versions.length ? evalRoom(versions[0].roomId) : roomIds.some((id) => provenance.includes(`"${id}"`));
    if (createdHere) {
      plan.remove.push(entry.id);
      continue;
    }
    const dropVersions = versions.filter((v) => evalRoom(v.roomId)).map((v) => v.id);
    const keep = versions.filter((v) => !evalRoom(v.roomId)).at(-1);
    const unarchive = Boolean(entry.archivedAt && archivedSince && entry.archivedAt >= archivedSince);
    if (!dropVersions.length && !unarchive) continue;
    plan.restore.push({ id: entry.id, ...(dropVersions.length && keep ? { content: { title: keep.title, body: keep.body, tags: keep.tags } } : {}), unarchive, dropVersions });
  }
  return plan;
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

  let since: Date | null = null;
  let proposalIds: string[] = [];
  let audits: { id: string; actionType: string; entityType: string; entityId: string }[] = [];

  await step("rooms", async () => {
    const rooms = await prisma.jackRoom.findMany({ where: { id: { in: ids } }, select: { createdAt: true } });
    since = rooms.reduce<Date | null>((min, room) => (!min || room.createdAt < min ? room.createdAt : min), null);
  });
  await step("proposals", async () => {
    proposalIds = (await prisma.jackProposal.findMany({ where: { roomId: { in: ids } }, select: { id: true } })).map((p) => p.id);
    report.proposals = proposalIds.length;
  });
  await step("audit entries", async () => {
    audits = await prisma.auditLog.findMany({
      where: { OR: ids.map((id) => ({ metadata: { path: ["roomId"], equals: id } })) },
      select: { id: true, actionType: true, entityType: true, entityId: true },
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
    const touched = new Set((await prisma.knowledgeEntryVersion.findMany({ where: { roomId: { in: ids } }, select: { entryId: true } })).map((v) => v.entryId));
    for (const a of audits) touched.add(a.entityId);
    if (!touched.size) return;
    const entries = await prisma.knowledgeEntry.findMany({
      where: { id: { in: [...touched] } },
      select: { id: true, createdAt: true, archivedAt: true, provenance: true, versions: { select: { id: true, roomId: true, title: true, body: true, tags: true, createdAt: true } } },
    });
    const plan = knowledgePlan(entries, ids, since);
    if (plan.remove.length) report.knowledgeDeleted = (await prisma.knowledgeEntry.deleteMany({ where: { id: { in: plan.remove } } })).count;
    for (const entry of plan.restore) {
      await prisma.knowledgeEntry.update({ where: { id: entry.id }, data: { ...entry.content, ...(entry.unarchive ? { archivedAt: null } : {}) } });
      if (entry.dropVersions.length) await prisma.knowledgeEntryVersion.deleteMany({ where: { id: { in: entry.dropVersions } } });
      report.knowledgeRestored++;
      report.left.push(`knowledge entry ${entry.id} existed before the eval changed it: restored ${entry.content ? "its last version" : "it"}; check its reviewed status`);
    }
  });

  await step("files", async () => {
    const files = await prisma.jackFile.findMany({
      where: { roomId: { in: ids } },
      select: { id: true, storagePath: true, modelCopyPath: true, thumbPath: true, anthropicFileId: true },
    });
    report.files = files.length;
    const paths = files.flatMap((f) => [f.storagePath, f.modelCopyPath, f.thumbPath].filter((p): p is string => Boolean(p)));
    if (paths.length && !options.deleteObject) report.left.push(`${paths.length} stored file object(s) (this file store can't delete): ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ", ..." : ""}`);
    for (const path of options.deleteObject ? paths : []) {
      try {
        await options.deleteObject!(path);
        report.storageObjects++;
      } catch (error) {
        report.left.push(`stored object ${path}: ${error instanceof Error ? error.message : String(error)}`);
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
    if (audits.length) report.auditEntries = (await prisma.auditLog.deleteMany({ where: { id: { in: audits.map((a) => a.id) } } })).count;
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
