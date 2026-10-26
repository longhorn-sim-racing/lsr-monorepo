import { seedKnowledgeFixtures, type KnowledgeFixture } from "./knowledge-fixtures";
import type { EvalSeeder } from "./types";

/**
 * The memory questions' knowledge entries (tracks/memory.ts): one to refuse a duplicate of, one to
 * update on top of its version, and one old enough that Jack should mention its age. Made-up how-tos.
 */
export const MEMORY_FIXTURES = {
  /** knowledge-duplicate: asking to remember this again should find it, not save a second copy */
  rigCleaning: {
    id: "e7a1f1c0-5eed-4000-8000-000000000201",
    versionId: "e7a1f1c0-5eed-4000-8000-000000000202",
    title: "Cleaning the sim rigs after a session",
    body: "Wipe the wheels, shifters and pedals with the green microfiber cloths after every session. Spare cloths are in the blue bin under rig 3.",
    tags: ["rigs", "how-to"],
    sourceDate: new Date("2026-09-15T17:00:00Z"),
    reviewed: true,
  },
  /** knowledge-update-version: "two weeks" becomes "three weeks" */
  loungeBooking: {
    id: "e7a1f1c0-5eed-4000-8000-000000000203",
    versionId: "e7a1f1c0-5eed-4000-8000-000000000204",
    title: "Booking the lounge for club events",
    body: "Book the lounge through the Student Activities office at least two weeks before the event. Pick up the projector remote at the front desk on the day.",
    tags: ["events", "how-to"],
    sourceDate: new Date("2026-09-20T17:00:00Z"),
    reviewed: true,
  },
  /** knowledge-age: dated March 2025 and never reviewed, so well past 180 days */
  trophies: {
    id: "e7a1f1c0-5eed-4000-8000-000000000205",
    versionId: "e7a1f1c0-5eed-4000-8000-000000000206",
    title: "Where the Lone Star Cup trophies are kept",
    body: "The Lone Star Cup trophies are kept in the locked cabinet in the club's storage closet. The Competition director has the key.",
    tags: ["lsc", "storage"],
    sourceDate: new Date("2025-03-15T17:00:00Z"),
    reviewed: false,
  },
} satisfies Record<string, KnowledgeFixture>;

/** Fills the eval copy with the memory track's fake data before a run (pnpm jack:eval:prepare). Must be safe to run again */
export const SEEDERS: EvalSeeder[] = [
  {
    name: "memory: knowledge entries for the memory questions",
    run: (ctx) => seedKnowledgeFixtures(ctx, Object.values(MEMORY_FIXTURES)),
  },
];
