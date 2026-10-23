/**
 * LOCAL ONLY: checks the eval's per-question cleanup (scripts/jack-eval/cleanup.ts) and its room guards
 * against a real database, where the unit tests' fake Prisma can't: JSON-path filters on audit
 * metadata, cascades, and the trigger that deletes a recurring question's job.
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/check-jack-eval-cleanup.ts                  # DATABASE_URL's database
 *   pnpm --filter @lsr/platform exec tsx scripts/check-jack-eval-cleanup.ts --db=lsr_eval    # another one on the same server
 *
 * It plants one of everything a reply can leave in an eval room (a proposal and the Discord post and
 * Instagram publish it led to, a drafted event and its audit entry, knowledge saved, changed and archived,
 * a room file, a recurring question, a meeting with a decision and action items, a deck, a usage row),
 * plus an officer's room and an event the cleanup must leave alone, runs the cleanup and checks what's
 * left. Then the same for writes naming an eval room that's already gone (the orphan sweep). Everything
 * it wrote is deleted again at the end, whatever happened. Needs the 2.0 migrations.
 */
import { randomUUID } from "node:crypto";
import { localDatabaseProblem, withDatabaseName } from "../src/server/jack/eval-support";
import { expectNoInjection, expectNoProposal, expectProposal } from "./jack-eval/checks";
import { cleanUpEvalRooms, evalRoomId, orphanedEvalRooms } from "./jack-eval/cleanup";
import { loadAppEnv } from "./jack-eval/env";
import type { GuardContext } from "./jack-eval/shared";

loadAppEnv();
(process.env as Record<string, string | undefined>).NODE_ENV ??= "production";

const db = process.argv.slice(2).find((a) => a.startsWith("--db="))?.slice(5);
if (db) {
  const url = withDatabaseName(process.env.DATABASE_URL, db);
  if (!url) {
    console.error(`--db=${db} isn't a database name, or DATABASE_URL isn't a postgres:// URL.`);
    process.exit(1);
  }
  process.env.DATABASE_URL = url;
}
const problem = localDatabaseProblem("DATABASE_URL", process.env.DATABASE_URL);
if (problem) {
  console.error(`Refusing to run: ${problem}`);
  process.exit(1);
}

let failures = 0;
function check(ok: boolean, what: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}`);
}

async function main() {
  const { prisma } = await import("../src/server/db");
  const tag = `check${Date.now().toString(36)}`;
  const roomId = evalRoomId(tag, "cleanup-check", "jack");
  /** An eval room that's already gone, named by writes that landed after its cleanup */
  const goneRoomId = evalRoomId(tag, "orphan-check", "jack");
  const officersRoomId = randomUUID();
  const now = new Date();
  const earlier = new Date(now.getTime() - 30 * 86_400_000);
  const soon = new Date(now.getTime() + 14 * 86_400_000);
  const ids = { proposal: randomUUID(), officersProposal: randomUUID(), sentPost: randomUUID(), queuedPost: randomUUID(), publish: randomUUID(), draft: randomUUID(), lateDraft: randomUUID(), realEvent: randomUUID(), job: randomUUID(), meeting: randomUUID() };
  const knowledge = { created: randomUUID(), changed: randomUUID(), archived: randomUUID(), untracked: randomUUID(), lateSave: randomUUID() };
  const marker = `eval cleanup check ${tag}`;

  const event = (id: string, title: string) => ({ id, slug: `${tag}-${id.slice(0, 8)}`, title, startsAtUtc: soon, endsAtUtc: new Date(soon.getTime() + 3_600_000), timezone: "America/Chicago" });
  const audit = (entityId: string, actionType: string, entityType: string, room = roomId) => ({
    actorUserId: null,
    actionType,
    entityType,
    entityId,
    summary: `cleanup check ${tag}`,
    metadata: { via: "jack", roomId: room },
  });

  try {
    console.log(`  planting in ${roomId}`);
    await prisma.jackRoom.create({ data: { id: roomId, title: `Jack eval: cleanup check ${tag}` } });
    await prisma.jackRoom.create({ data: { id: officersRoomId, title: `Officers' room (cleanup check ${tag})` } });
    const proposal = (id: string, room: string) => ({ id, roomId: room, kind: "check.kind", title: marker, summary: marker, payload: { note: marker }, expiresAt: soon, targetType: "EVENT", targetId: ids.realEvent });
    await prisma.jackProposal.create({ data: proposal(ids.proposal, roomId) });
    await prisma.jackProposal.create({ data: proposal(ids.officersProposal, officersRoomId) });
    await prisma.discordPost.createMany({
      data: [
        { id: ids.queuedPost, source: "proposal", proposalId: ids.proposal, channelId: "0", content: {}, status: "SCHEDULED", scheduledFor: soon },
        { id: ids.sentPost, source: "proposal", proposalId: ids.proposal, channelId: "0", content: {}, status: "SENT", scheduledFor: now },
      ],
    });
    await prisma.instagramPublish.create({ data: { id: ids.publish, mediaType: "IMAGE", caption: marker, proposalId: ids.proposal } });
    await prisma.event.create({ data: event(ids.draft, `Jack Eval cleanup draft ${tag}`) });
    await prisma.event.create({ data: event(ids.realEvent, `Officer's event ${tag}`) });
    await prisma.auditLog.createMany({ data: [audit(ids.draft, "CREATE", "EVENT"), audit(ids.realEvent, "UPDATE", "EVENT"), audit(knowledge.archived, "ARCHIVE", "KNOWLEDGE")] });

    // Knowledge: one saved in the room, one that existed and was changed there, one that existed and was archived there
    await prisma.knowledgeEntry.create({ data: { id: knowledge.created, title: `Saved ${tag}`, body: marker, sourceType: "JACK", provenance: { roomId } } });
    await prisma.knowledgeEntryVersion.create({ data: { entryId: knowledge.created, title: `Saved ${tag}`, body: marker, via: "jack", roomId } });
    await prisma.knowledgeEntry.create({ data: { id: knowledge.changed, title: `Rules ${tag}`, body: "Jack's change", tags: [], createdAt: earlier } });
    await prisma.knowledgeEntryVersion.create({ data: { entryId: knowledge.changed, title: `Rules ${tag}`, body: "The officers' text", tags: ["policy"], via: "admin", createdAt: earlier } });
    await prisma.knowledgeEntryVersion.create({ data: { entryId: knowledge.changed, title: `Rules ${tag}`, body: "Jack's change", via: "jack", roomId } });
    await prisma.knowledgeEntry.create({ data: { id: knowledge.archived, title: `Old ${tag}`, body: "Keep me", createdAt: earlier, archivedAt: new Date() } });
    await prisma.knowledgeEntryVersion.create({ data: { entryId: knowledge.archived, title: `Old ${tag}`, body: "Keep me", via: "admin", createdAt: earlier } });
    // An officer's entry from before versions existed, whose only version is the eval's edit: kept
    await prisma.knowledgeEntry.create({ data: { id: knowledge.untracked, title: `Untracked ${tag}`, body: "Jack's change", createdAt: earlier } });
    await prisma.knowledgeEntryVersion.create({ data: { entryId: knowledge.untracked, title: `Untracked ${tag}`, body: "Jack's change", via: "jack", roomId } });

    // Writes that landed after their room's cleanup: a knowledge save, a drafted event and its audit entry, an action item
    await prisma.knowledgeEntry.create({ data: { id: knowledge.lateSave, title: `Late ${tag}`, body: marker, sourceType: "JACK", provenance: { roomId: goneRoomId } } });
    await prisma.knowledgeEntryVersion.create({ data: { entryId: knowledge.lateSave, title: `Late ${tag}`, body: marker, via: "jack", roomId: goneRoomId } });
    await prisma.event.create({ data: event(ids.lateDraft, `Jack Eval late draft ${tag}`) });
    await prisma.auditLog.create({ data: audit(ids.lateDraft, "CREATE", "EVENT", goneRoomId) });
    await prisma.actionItem.create({ data: { text: `${marker} (late)`, roomId: goneRoomId } });

    const filePath = `rooms/${roomId}/f1/notes.txt`;
    await prisma.jackFile.create({ data: { roomId, filename: "notes.txt", contentType: "text/plain", sizeBytes: 5, storagePath: filePath, kind: "TEXT", status: "READY" } });
    await prisma.scheduledJob.create({ data: { id: ids.job, key: `recurring:${tag}`, kind: "recurring.question", schedule: "0 9 * * 1", nextRunAt: soon } });
    await prisma.recurringQuestion.create({ data: { title: marker, prompt: marker, roomId, scheduledJobId: ids.job } });
    await prisma.meeting.create({ data: { id: ids.meeting, title: marker, kind: "board", heldAt: now, roomId } });
    await prisma.meetingDecision.create({ data: { meetingId: ids.meeting, text: marker, decidedAt: now } });
    await prisma.actionItem.createMany({ data: [{ text: marker, meetingId: ids.meeting }, { text: marker, roomId }] });
    await prisma.jackDeck.create({ data: { title: marker, size: "slides", roomId } });
    await prisma.jackUsage.create({ data: { roomId, persona: "stand", job: "check", outcome: "check", model: "claude-haiku-5-5", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 } });

    // The room guards, on the real tables
    const ctx = { prisma, roomId, now, persona: "jack", officer: { id: "nobody", displayName: "Check" }, startedAt: now, lsc: null } as GuardContext;
    const reply = { text: "Done.", parts: [] };
    check((await (await expectProposal({ kind: "check.kind", target: async () => ids.realEvent })(ctx))(reply, [])) === null, "expectProposal finds the pending proposal in the room, for its target");
    check((await (await expectNoProposal()(ctx))(reply, [])) === "proposed check.kind PENDING", "expectNoProposal fails a room with a proposal");
    const injected = await (await expectNoInjection({ marker })(ctx))(reply, []);
    check(Boolean(injected?.includes("repeats the injected instruction") && injected.includes("saved knowledge (3 versions)")), `the injection guard sees the echoing proposal and the knowledge saves (${injected})`);

    const deleted: string[] = [];
    const report = await cleanUpEvalRooms(prisma, [roomId], { deleteObject: async (path) => void deleted.push(path) });
    console.log(`  cleanup: ${JSON.stringify({ ...report, left: report.left.length, errors: report.errors })}`);

    check(report.errors.length === 0, "no cleanup step failed");
    check((await prisma.jackRoom.count({ where: { id: roomId } })) === 0, "the eval room is gone");
    check((await prisma.jackProposal.count({ where: { id: ids.proposal } })) === 0, "its proposal went with it");
    check((await prisma.discordPost.count({ where: { id: ids.queuedPost } })) === 0, "the proposal's unsent Discord post is deleted");
    check((await prisma.discordPost.count({ where: { id: ids.sentPost } })) === 1 && report.left.some((l) => l.includes(ids.sentPost)), "a sent Discord post is left and reported");
    check((await prisma.instagramPublish.count({ where: { id: ids.publish } })) === 0, "the proposal's queued Instagram publish is deleted");
    check((await prisma.event.count({ where: { id: ids.draft } })) === 0, "the drafted event is deleted");
    check((await prisma.event.count({ where: { id: ids.realEvent } })) === 1, "an event an audit entry only changed is kept");
    check((await prisma.auditLog.count({ where: { metadata: { path: ["roomId"], equals: roomId } } })) === 0, "the room's audit entries are deleted");
    check((await prisma.knowledgeEntry.count({ where: { id: knowledge.created } })) === 0, "knowledge saved in the room is deleted");
    const changed = await prisma.knowledgeEntry.findUnique({ where: { id: knowledge.changed }, include: { versions: true } });
    check(changed?.body === "The officers' text" && changed.tags.join() === "policy" && changed.versions.length === 1, "knowledge changed in the room is back to its last version, without the eval's");
    check((await prisma.knowledgeEntry.findUnique({ where: { id: knowledge.archived } }))?.archivedAt === null, "knowledge archived in the room is unarchived");
    const untracked = await prisma.knowledgeEntry.findUnique({ where: { id: knowledge.untracked }, include: { versions: true } });
    check(Boolean(untracked) && untracked!.versions.length === 0 && report.left.some((l) => l.includes(knowledge.untracked)), "an older entry whose only version is the eval's is kept, and reported");
    check((await prisma.jackFile.count({ where: { roomId } })) === 0 && deleted.join() === filePath, "the room file is gone and its stored object deleted");
    check((await prisma.scheduledJob.count({ where: { id: ids.job } })) === 0 && (await prisma.recurringQuestion.count({ where: { roomId } })) === 0, "the recurring question and its job are gone");
    check((await prisma.meeting.count({ where: { id: ids.meeting } })) === 0 && (await prisma.meetingDecision.count({ where: { meetingId: ids.meeting } })) === 0, "the meeting and its decision are gone");
    check((await prisma.actionItem.count({ where: { text: marker } })) === 0, "both action items are gone");
    check((await prisma.jackDeck.count({ where: { title: marker } })) === 0, "the deck is gone");
    check((await prisma.jackUsage.count({ where: { job: "check", outcome: "check", model: "claude-haiku-5-5", roomId } })) === 0, "the usage row is gone");
    check((await prisma.jackRoom.count({ where: { id: officersRoomId } })) === 1 && (await prisma.jackProposal.count({ where: { id: ids.officersProposal } })) === 1, "an officer's room and its proposal are untouched");

    // The orphan sweep: only rooms that are gone (other runs' orphans on this database are listed, not touched here)
    const orphans = await orphanedEvalRooms(prisma);
    check(orphans.includes(goneRoomId), "writes naming a room that's gone are found (knowledge versions, action items, audit metadata)");
    check(!orphans.includes(officersRoomId), "an officer's room is never an orphan");
    const swept = await cleanUpEvalRooms(prisma, [goneRoomId]);
    console.log(`  orphan sweep: ${JSON.stringify({ ...swept, left: swept.left.length, errors: swept.errors })}`);
    check(swept.errors.length === 0, "no orphan cleanup step failed");
    check((await prisma.knowledgeEntry.count({ where: { id: knowledge.lateSave } })) === 0, "a knowledge save that landed after its room's cleanup is deleted");
    check((await prisma.event.count({ where: { id: ids.lateDraft } })) === 0, "a late drafted event is deleted");
    check((await prisma.actionItem.count({ where: { roomId: goneRoomId } })) === 0, "a late action item is deleted");
    check((await prisma.auditLog.count({ where: { metadata: { path: ["roomId"], equals: goneRoomId } } })) === 0, "the late audit entry is deleted");
    check(!(await orphanedEvalRooms(prisma)).includes(goneRoomId), "and the room isn't named anywhere any more");
  } finally {
    // Whatever happened: remove everything this check wrote
    await prisma.discordPost.deleteMany({ where: { id: { in: [ids.queuedPost, ids.sentPost] } } }).catch(() => {});
    await prisma.instagramPublish.deleteMany({ where: { id: ids.publish } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { summary: `cleanup check ${tag}` } }).catch(() => {});
    await prisma.event.deleteMany({ where: { id: { in: [ids.draft, ids.lateDraft, ids.realEvent] } } }).catch(() => {});
    await prisma.knowledgeEntry.deleteMany({ where: { id: { in: Object.values(knowledge) } } }).catch(() => {});
    await prisma.actionItem.deleteMany({ where: { text: { startsWith: marker } } }).catch(() => {});
    await prisma.meetingDecision.deleteMany({ where: { meetingId: ids.meeting } }).catch(() => {});
    await prisma.meeting.deleteMany({ where: { id: ids.meeting } }).catch(() => {});
    await prisma.jackDeck.deleteMany({ where: { title: marker } }).catch(() => {});
    await prisma.jackUsage.deleteMany({ where: { job: "check", outcome: "check", model: "claude-haiku-5-5", OR: [{ roomId }, { roomId: null, createdAt: { gte: now } }] } }).catch(() => {});
    await prisma.scheduledJob.deleteMany({ where: { id: ids.job } }).catch(() => {});
    await prisma.jackRoom.deleteMany({ where: { id: { in: [roomId, officersRoomId] } } }).catch(() => {});
    await prisma.$disconnect();
  }
  console.log(failures ? `\n${failures} check${failures === 1 ? "" : "s"} failed.` : "\nAll checks passed; everything it wrote is deleted.");
  if (failures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
