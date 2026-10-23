import { describe, expect, it, vi } from "vitest";
import type { Answer, EvalContext, GuardContext, Question } from "../shared";

// The tools are imported for real (their input schemas check the dry run's calls); nothing touches a database
vi.mock("@/server/db", () => ({ prisma: {} }));
vi.mock("@/server/jack/sql-client", () => ({ getJackSqlClient: () => null, JACK_SQL_MISSING: "missing" }));

import { findJackTool } from "../../../src/server/jack/tools";
import { instagramPublishSchema } from "../../../src/server/jack/proposals/decks-rooms/instagram-publish";
import { galleryAddSchema } from "../../../src/server/jack/proposals/decks-rooms/gallery-add";
import { DR_SEED } from "../seed/decks-rooms";
import { QUESTIONS } from "./decks-rooms";

const NOW = new Date("2026-10-23T17:00:00Z");
const NON_ANSWER: Answer = { text: "Here's what I have.", parts: [] };

/** A fake Prisma client: the seeded rows when `seeded`, the room's proposals as given, and counts that never change */
function fakeDb({ seeded = true, proposals = [] as unknown[] } = {}) {
  return {
    jackDeck: { findUnique: vi.fn(async () => (seeded ? { id: DR_SEED.deck } : null)) },
    galleryAlbum: { findUnique: vi.fn(async () => (seeded ? { id: DR_SEED.album } : null)) },
    instagramPublish: { count: vi.fn(async () => 0) },
    galleryImage: { count: vi.fn(async () => 12) },
    jackProposal: { findMany: vi.fn(async () => proposals) },
  };
}

const context = (db: ReturnType<typeof fakeDb>): GuardContext => ({ prisma: db as unknown as EvalContext["prisma"], now: NOW, persona: "jack", officer: { id: "o1", displayName: "Dylan" }, startedAt: NOW, lsc: null, roomId: "jack-eval-t9b-jack-q-1" });

async function guarded(question: Question, ctx: GuardContext) {
  const guards = Array.isArray(question.guard) ? question.guard : question.guard ? [question.guard] : [];
  const checks = await Promise.all(guards.map((guard) => guard(ctx)));
  return (await Promise.all(checks.map((check) => check(NON_ANSWER, [])))).filter(Boolean);
}

describe("the decks-rooms questions", () => {
  it("are propose questions that wait for their kinds, skip without the seeded graphic, and never let an apply through", async () => {
    expect(QUESTIONS.map((q) => q.id)).toEqual(["publish-propose-carousel", "publish-story-no-caption", "publish-no-direct-post", "gallery-propose-slides"]);
    for (const q of QUESTIONS) {
      expect(q.group, q.id).toBe("propose");
      expect(q.requires?.kinds?.length, q.id).toBe(1);
      expect(Array.isArray(q.guard) ? q.guard.length : 0, q.id).toBe(2);
      expect(await q.truth(context(fakeDb({ seeded: false }))), q.id).toBeNull();
    }
  });

  it("script calls the real tools take, with payloads the kinds take", async () => {
    for (const q of QUESTIONS) {
      const truth = await q.truth(context(fakeDb()));
      expect(truth?.judgeOnly, q.id).toBe(true);
      for (const call of truth?.fakeCalls ?? []) {
        const tool = findJackTool(call.name);
        expect(tool, `${q.id}: ${call.name}`).toBeDefined();
        expect(tool!.input.safeParse(call.input).success, `${q.id}: ${call.name}`).toBe(true);
        if (call.name !== "propose_deck_publish") continue;
        const { kind, ...payload } = (call.input as { proposal: { kind: string } }).proposal;
        const schema = kind === "instagram.publish" ? instagramPublishSchema : galleryAddSchema;
        expect(schema.safeParse(payload).success, `${q.id}: ${kind}`).toBe(true);
        expect(q.requires?.kinds).toEqual([kind]);
      }
    }
  });

  it("pass a pending proposal for the seeded deck or album, and fail an apply, another target or none", async () => {
    const publish = QUESTIONS.find((q) => q.id === "publish-propose-carousel")!;
    const pending = (kind: string, targetId: string, status = "PENDING") => ({ kind, status, targetId, claimedAt: status === "PENDING" ? null : NOW, title: "", summary: "", payload: {} });
    expect(await guarded(publish, context(fakeDb({ proposals: [pending("instagram.publish", DR_SEED.deck)] })))).toEqual([]);
    expect(await guarded(publish, context(fakeDb({ proposals: [pending("instagram.publish", DR_SEED.deck, "APPLIED")] })))).toEqual([expect.stringContaining("an apply was attempted")]);
    expect(await guarded(publish, context(fakeDb({ proposals: [pending("instagram.publish", "another-deck")] })))).toEqual([expect.stringContaining(`not ${DR_SEED.deck}`)]);
    expect(await guarded(publish, context(fakeDb()))).toEqual(["proposed nothing (expected instagram.publish)"]);

    const gallery = QUESTIONS.find((q) => q.id === "gallery-propose-slides")!;
    expect(await guarded(gallery, context(fakeDb({ proposals: [pending("gallery.add", `${DR_SEED.album}:${DR_SEED.deck}`)] })))).toEqual([]);
  });
});
