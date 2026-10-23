import { describe, expect, it, vi } from "vitest";
import { cleanUpEvalRooms, describeCleanup, EVAL_ROOM_PREFIX, evalRoomId, isEvalRoomId, knowledgePlan, leftoverEvalRooms, LEGACY_EVAL_ROOM_ID, orphanedEvalRooms, runRooms, runTag } from "./cleanup";
import type { EvalContext } from "./shared";

const ROOM = "jack-eval-mh2k1-jack-propose-email-lsc-ab12";
const at = (iso: string) => new Date(iso);

/** A fake Prisma client: each model's methods return what `data` says, and every call is recorded in order */
function fakeDb(data: Partial<Record<string, unknown[]>> = {}) {
  const calls: string[] = [];
  const method = (name: string, result: (args: unknown) => unknown) =>
    vi.fn(async (args: unknown) => {
      calls.push(name);
      return result(args);
    });
  const list = (name: string) => method(`${name}.findMany`, () => data[name] ?? []);
  const remove = (name: string) => method(`${name}.deleteMany`, (args) => ({ count: ((args as { where: { id?: { in: string[] } } }).where.id?.in ?? data[name] ?? []).length }));
  const db = {
    jackRoom: { findMany: list("jackRoom"), deleteMany: remove("jackRoom") },
    jackProposal: { findMany: list("jackProposal") },
    auditLog: { findMany: list("auditLog"), deleteMany: remove("auditLog") },
    discordPost: { findMany: list("discordPost"), deleteMany: remove("discordPost") },
    instagramPublish: { findMany: list("instagramPublish"), deleteMany: remove("instagramPublish") },
    event: { deleteMany: remove("event") },
    knowledgeEntryVersion: { findMany: list("knowledgeEntryVersion"), deleteMany: remove("knowledgeEntryVersion") },
    knowledgeEntry: { findMany: list("knowledgeEntry"), deleteMany: remove("knowledgeEntry"), update: method("knowledgeEntry.update", () => ({})) },
    jackFile: { findMany: list("jackFile") },
    recurringQuestion: { findMany: list("recurringQuestion") },
    scheduledJob: { deleteMany: remove("scheduledJob") },
    meeting: { findMany: list("meeting"), deleteMany: remove("meeting") },
    meetingDecision: { deleteMany: remove("meetingDecision") },
    actionItem: { findMany: list("actionItem"), deleteMany: remove("actionItem") },
    jackDeck: { deleteMany: remove("jackDeck") },
    jackUsage: { deleteMany: remove("jackUsage") },
    $queryRaw: method("$queryRaw", () => data.$queryRaw ?? []),
  };
  return { db, calls, prisma: db as unknown as EvalContext["prisma"] };
}

describe("eval room ids", () => {
  it("are fresh per question and model, start with the eval prefix, and hold no odd characters", () => {
    const id = evalRoomId(runTag(at("2026-10-23T02:00:00Z")), "paired-lsc-season@media", "jack");
    expect(id).toMatch(/^jack-eval-[a-z0-9]+-jack-paired-lsc-season-media-[a-z0-9]{1,4}$/);
    expect(evalRoomId("r", "q", "jack")).not.toBe(evalRoomId("r", "q", "jack"));
    expect(isEvalRoomId(id)).toBe(true);
    expect(isEvalRoomId(LEGACY_EVAL_ROOM_ID)).toBe(true);
    expect(isEvalRoomId("3f1c9a52-8a0e-4d0b-9e57-0c1f8f1f2a10")).toBe(false);
  });
});

describe("cleanUpEvalRooms", () => {
  it("does nothing for no rooms, or for rooms that aren't the eval's", async () => {
    const { prisma, calls } = fakeDb();
    expect(await cleanUpEvalRooms(prisma, [])).toMatchObject({ rooms: 0, errors: [] });
    await cleanUpEvalRooms(prisma, ["3f1c9a52-8a0e-4d0b-9e57-0c1f8f1f2a10"]);
    expect(calls).toEqual([]);
  });

  it("undoes what a question made in its room, and deletes the room last", async () => {
    const { prisma, db, calls } = fakeDb({
      jackRoom: [{ createdAt: at("2026-10-23T02:00:00Z") }],
      jackProposal: [{ id: "p1" }, { id: "p2" }],
      auditLog: [
        { id: "a1", actionType: "CREATE", entityType: "EVENT", entityId: "draft-1" },
        { id: "a2", actionType: "UPDATE", entityType: "EVENT", entityId: "real-event" },
      ],
      discordPost: [
        { id: "d1", status: "SCHEDULED" },
        { id: "d2", status: "SENT" },
      ],
      instagramPublish: [{ id: "i1", status: "queued" }],
      jackFile: [{ id: "f1", storagePath: `rooms/${ROOM}/f1/a.png`, modelCopyPath: `rooms/${ROOM}/f1/model.jpg`, thumbPath: null, anthropicFileId: "file_1" }],
      recurringQuestion: [{ scheduledJobId: "job-1" }],
      meeting: [{ id: "m1" }],
    });
    const deleteObject = vi.fn(async () => {});
    const report = await cleanUpEvalRooms(prisma, [ROOM, ROOM], { deleteObject });

    // Proposals' Discord posts that never went out are deleted; one that was sent is left for a person to check
    expect(db.discordPost.findMany).toHaveBeenCalledWith({ where: { proposalId: { in: ["p1", "p2"] } }, select: { id: true, status: true } });
    expect(db.discordPost.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["d1"] } } });
    expect(report.left).toContain("Discord post d2 from an eval proposal is SENT: check Discord");
    expect(db.instagramPublish.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["i1"] } } });
    // Only events Jack created as drafts; never one an audit entry only changed
    expect(db.event.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["draft-1"] }, status: "DRAFT" } });
    expect(db.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { OR: [{ metadata: { path: ["roomId"], equals: ROOM } }] } }));
    expect(db.auditLog.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["a1", "a2"] } } });
    // Stored objects go through the store; a Claude file with no way to delete it is listed
    expect(deleteObject.mock.calls).toEqual([[`rooms/${ROOM}/f1/a.png`], [`rooms/${ROOM}/f1/model.jpg`]]);
    expect(report.left).toContain("Claude file file_1");
    expect(db.scheduledJob.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["job-1"] } } });
    expect(db.meetingDecision.deleteMany).toHaveBeenCalledWith({ where: { meetingId: { in: ["m1"] } } });
    expect(db.actionItem.deleteMany).toHaveBeenCalledWith({ where: { OR: [{ roomId: { in: [ROOM] } }, { meetingId: { in: ["m1"] } }] } });
    expect(db.jackDeck.deleteMany).toHaveBeenCalledWith({ where: { roomId: { in: [ROOM] } } });
    expect(db.jackRoom.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [ROOM] } } });
    expect(calls.at(-1)).toBe("jackRoom.deleteMany");
    expect(calls.indexOf("auditLog.findMany")).toBeLessThan(calls.indexOf("event.deleteMany"));
    // Deleting a meeting only unlinks its action items and decisions, so they go first
    expect(calls.indexOf("actionItem.deleteMany")).toBeLessThan(calls.indexOf("meeting.deleteMany"));
    expect(calls.indexOf("meetingDecision.deleteMany")).toBeLessThan(calls.indexOf("meeting.deleteMany"));
    expect(report).toMatchObject({ rooms: 1, proposals: 2, discordPosts: 1, instagramPublishes: 1, events: 1, files: 1, storageObjects: 2, recurringQuestions: 1, auditEntries: 2, errors: [] });
  });

  it("lists stored objects it can't delete when the file store has no delete", async () => {
    const { prisma } = fakeDb({ jackFile: [{ id: "f1", storagePath: "rooms/r/f1/a.pdf", modelCopyPath: null, thumbPath: null, anthropicFileId: null }] });
    const report = await cleanUpEvalRooms(prisma, [ROOM]);
    expect(report.left).toEqual(["1 stored file object(s) (this file store can't delete): rooms/r/f1/a.pdf"]);
  });

  it("keeps going when a step fails, and reports it", async () => {
    const { prisma, db } = fakeDb();
    db.knowledgeEntryVersion.findMany.mockRejectedValueOnce(new Error('Invalid `prisma.knowledgeEntryVersion.findMany()` invocation:\n\nThe table "KnowledgeEntryVersion" does not exist'));
    const report = await cleanUpEvalRooms(prisma, [ROOM]);
    expect(report.errors).toEqual(['knowledge: The table "KnowledgeEntryVersion" does not exist']);
    expect(db.jackRoom.deleteMany).toHaveBeenCalled();
  });

  it("deletes knowledge the eval created and puts back what it changed", async () => {
    const before = at("2026-10-01T00:00:00Z");
    const during = at("2026-10-23T02:01:00Z");
    const { prisma, db } = fakeDb({
      jackRoom: [{ createdAt: at("2026-10-23T02:00:00Z") }],
      knowledgeEntryVersion: [{ entryId: "new" }, { entryId: "old" }],
      knowledgeEntry: [
        { id: "new", createdAt: during, archivedAt: null, provenance: null, versions: [{ id: "v1", roomId: ROOM, title: "T", body: "B", tags: [], createdAt: during }] },
        {
          id: "old",
          createdAt: before,
          archivedAt: null,
          provenance: null,
          versions: [
            { id: "v0", roomId: null, title: "Rules", body: "Real text", tags: ["policy"], createdAt: before },
            { id: "v2", roomId: ROOM, title: "Rules", body: "Jack's text", tags: [], createdAt: during },
          ],
        },
      ],
    });
    const report = await cleanUpEvalRooms(prisma, [ROOM]);
    expect(db.knowledgeEntry.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["new"] } } });
    expect(db.knowledgeEntry.update).toHaveBeenCalledWith({ where: { id: "old" }, data: { title: "Rules", body: "Real text", tags: ["policy"] } });
    expect(db.knowledgeEntryVersion.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["v2"] } } });
    expect(report).toMatchObject({ knowledgeDeleted: 1, knowledgeRestored: 1 });
    expect(report.left).toEqual(["knowledge entry old existed before the eval changed it: restored its last version; check its reviewed status"]);
  });

  it("for a room already gone, times knowledge from the eval's first write naming it", async () => {
    const write = at("2026-10-23T02:01:00Z");
    const { prisma, db } = fakeDb({
      jackRoom: [],
      knowledgeEntryVersion: [{ entryId: "late", createdAt: write }, { entryId: "officers", createdAt: write }],
      knowledgeEntry: [
        // Saved by a tool that finished after the room's cleanup: the eval's
        { id: "late", createdAt: write, archivedAt: null, provenance: null, versions: [{ id: "v1", roomId: ROOM, title: "T", body: "B", tags: [], createdAt: write }] },
        // An officer's entry from before, with no history, that the late write changed: kept
        { id: "officers", createdAt: at("2026-09-01T00:00:00Z"), archivedAt: null, provenance: null, versions: [{ id: "v2", roomId: ROOM, title: "T", body: "Jack's", tags: [], createdAt: write }] },
      ],
    });
    const report = await cleanUpEvalRooms(prisma, [ROOM]);
    expect(db.knowledgeEntry.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["late"] } } });
    expect(db.knowledgeEntryVersion.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["v2"] } } });
    expect(db.knowledgeEntry.update).not.toHaveBeenCalled();
    expect(report.left).toEqual(["knowledge entry officers existed before the eval changed it, with no earlier version to restore: it keeps the eval's text; check it"]);
  });
});

describe("knowledgePlan", () => {
  const since = at("2026-10-23T02:00:00Z");
  const v = (id: string, roomId: string | null, iso: string) => ({ id, roomId, title: id, body: id, tags: [], createdAt: at(iso) });

  it("deletes an entry first saved in an eval room, or one with no versions whose provenance names the room", () => {
    const plan = knowledgePlan(
      [
        { id: "a", createdAt: since, archivedAt: null, provenance: null, versions: [v("v1", ROOM, "2026-10-23T02:01:00Z"), v("v2", null, "2026-10-23T03:00:00Z")] },
        { id: "b", createdAt: since, archivedAt: null, provenance: { roomId: ROOM, sources: [] }, versions: [] },
        { id: "c", createdAt: since, archivedAt: null, provenance: { roomId: "another-room" }, versions: [] },
      ],
      [ROOM],
      since
    );
    expect(plan.remove).toEqual(["a", "b"]);
    expect(plan.restore).toEqual([]);
  });

  it("restores an entry older than the eval's rooms even when its only version is the eval's", () => {
    const plan = knowledgePlan([{ id: "old", createdAt: at("2026-09-01T00:00:00Z"), archivedAt: null, provenance: null, versions: [v("v1", ROOM, "2026-10-23T02:01:00Z")] }], [ROOM], since);
    expect(plan.remove).toEqual([]);
    expect(plan.restore).toEqual([{ id: "old", unarchive: false, dropVersions: ["v1"] }]);
    // Made a little before the room by the clocks (skew), it's still the eval's
    expect(knowledgePlan([{ id: "new", createdAt: at("2026-10-23T01:59:30Z"), archivedAt: null, provenance: null, versions: [v("v1", ROOM, "2026-10-23T01:59:30Z")] }], [ROOM], since).remove).toEqual(["new"]);
  });

  it("deletes nothing when it can't tell when the eval's rooms were made", () => {
    const plan = knowledgePlan([{ id: "a", createdAt: since, archivedAt: null, provenance: { roomId: ROOM }, versions: [] }], [ROOM], null);
    expect(plan.remove).toEqual([]);
    expect(plan.left).toEqual(["knowledge entry a was saved in an eval room, but when the room was made is unknown: left in place"]);
  });

  it("puts an older entry back to its last version from outside the eval, and unarchives it if the eval archived it", () => {
    const plan = knowledgePlan(
      [
        { id: "x", createdAt: at("2026-09-01T00:00:00Z"), archivedAt: at("2026-10-23T02:05:00Z"), provenance: null, versions: [v("v1", null, "2026-09-01T00:00:00Z"), v("v2", null, "2026-09-10T00:00:00Z"), v("v3", ROOM, "2026-10-23T02:01:00Z")] },
        // Archived long before the eval: left archived; untouched otherwise
        { id: "y", createdAt: at("2026-09-01T00:00:00Z"), archivedAt: at("2026-09-02T00:00:00Z"), provenance: null, versions: [v("v4", null, "2026-09-01T00:00:00Z")] },
      ],
      [ROOM],
      since
    );
    expect(plan.remove).toEqual([]);
    expect(plan.restore).toEqual([{ id: "x", content: { title: "v2", body: "v2", tags: [] }, unarchive: true, dropVersions: ["v3"] }]);
  });

  it("allows a minute of clock skew between the room's time (database) and the archive time (app)", () => {
    const entry = (archivedAt: string) => ({ id: "z", createdAt: at("2026-09-01T00:00:00Z"), archivedAt: at(archivedAt), provenance: null, versions: [v("v1", null, "2026-09-01T00:00:00Z")] });
    expect(knowledgePlan([entry("2026-10-23T01:59:30Z")], [ROOM], since).restore).toEqual([{ id: "z", unarchive: true, dropVersions: [] }]);
    expect(knowledgePlan([entry("2026-10-23T01:55:00Z")], [ROOM], since).restore).toEqual([]);
  });
});

describe("finding eval rooms", () => {
  it("leftovers are other runs' rooms older than the cutoff, plus the pre-2.0 room id", async () => {
    const { prisma, db } = fakeDb({ jackRoom: [{ id: "jack-eval-old-jack-q-1" }] });
    const cutoff = at("2026-10-23T01:00:00Z");
    expect(await leftoverEvalRooms(prisma, cutoff)).toEqual([LEGACY_EVAL_ROOM_ID, "jack-eval-old-jack-q-1"]);
    expect(db.jackRoom.findMany).toHaveBeenCalledWith({ where: { id: { startsWith: EVAL_ROOM_PREFIX }, createdAt: { lt: cutoff } }, select: { id: true } });
  });

  it("a run's own rooms share its tag", async () => {
    const { prisma, db } = fakeDb({ jackRoom: [{ id: "jack-eval-tag1-jack-q-1" }] });
    expect(await runRooms(prisma, "tag1")).toEqual(["jack-eval-tag1-jack-q-1"]);
    expect(db.jackRoom.findMany).toHaveBeenCalledWith({ where: { id: { startsWith: "jack-eval-tag1-" } }, select: { id: true } });
  });

  it("orphans are eval rooms that are gone but still named by knowledge versions, action items or audit entries", async () => {
    const { prisma, db } = fakeDb({
      knowledgeEntryVersion: [{ roomId: "jack-eval-a" }],
      actionItem: [{ roomId: "jack-eval-b" }],
      $queryRaw: [{ roomId: "jack-eval-c" }, { roomId: "jack-eval-a" }],
      // b is still there (a question in progress, in this run or another)
      jackRoom: [{ id: "jack-eval-b" }],
    });
    expect(await orphanedEvalRooms(prisma)).toEqual(["jack-eval-a", "jack-eval-c"]);
    expect(db.knowledgeEntryVersion.findMany).toHaveBeenCalledWith({ where: { roomId: { startsWith: EVAL_ROOM_PREFIX } }, select: { roomId: true }, distinct: ["roomId"] });
    expect(db.actionItem.findMany).toHaveBeenCalledWith({ where: { roomId: { startsWith: EVAL_ROOM_PREFIX } }, select: { roomId: true }, distinct: ["roomId"] });
    expect(db.$queryRaw.mock.calls[0]).toContain("jack-eval-%");
    expect(db.jackRoom.findMany).toHaveBeenCalledWith({ where: { id: { in: ["jack-eval-a", "jack-eval-b", "jack-eval-c"] } }, select: { id: true } });
  });

  it("finds no orphans without asking about rooms when nothing names one", async () => {
    const { prisma, calls } = fakeDb();
    expect(await orphanedEvalRooms(prisma)).toEqual([]);
    expect(calls).not.toContain("jackRoom.findMany");
  });
});

describe("describeCleanup", () => {
  it("says what was removed and what was left, or nothing", async () => {
    const { prisma } = fakeDb();
    expect(describeCleanup(await cleanUpEvalRooms(prisma, []))).toBeNull();
    const report = { ...(await cleanUpEvalRooms(prisma, [])), rooms: 1, proposals: 2, auditEntries: 1, left: ["Claude file f"] };
    expect(describeCleanup(report)).toBe("1 room, 2 proposals, 1 audit entry; left: Claude file f");
  });
});
