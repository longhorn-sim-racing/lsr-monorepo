import { seedKnowledgeFixtures, type KnowledgeFixture } from "./knowledge-fixtures";
import type { EvalSeeder } from "./types";

/** search-decision-sponsor-tiers asks what was decided; this is a decision entry it should find and cite (tracks/club-data.ts) */
export const SPONSOR_TIERS_DECISION: KnowledgeFixture = {
  id: "e7a1f1c0-5eed-4000-8000-000000000101",
  versionId: "e7a1f1c0-5eed-4000-8000-000000000102",
  title: "Decision: where each sponsor tier is shown",
  body: "The board decided that Gold sponsors and above get their logo on the homepage and on the Sponsors page. Silver sponsors are shown on the Sponsors page only. Revisit when the sponsorship packet changes.",
  tags: ["decision", "sponsors"],
  sourceDate: new Date("2026-09-28T23:00:00Z"),
  reviewed: true,
};

/** Fills the eval copy with the club-data track's fake data before a run (pnpm jack:eval:prepare). Must be safe to run again */
export const SEEDERS: EvalSeeder[] = [
  {
    name: "club-data: a knowledge decision to search for",
    run: (ctx) => seedKnowledgeFixtures(ctx, [SPONSOR_TIERS_DECISION]),
  },
];
