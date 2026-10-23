import type { SeedContext } from "./types";

/**
 * Knowledge entries the eval asks about (memory and club-data questions), written straight into the
 * eval copy. Fake content only: how-tos and decisions made up for the eval, tagged `eval-fixture`, with
 * no owner. Each has fixed ids, so the questions find them and a rerun resets them: the entry goes back
 * to the fixture's text, unarchived, with exactly one version from outside any room (the one the eval's
 * cleanup puts an entry back to after a question changed it).
 */

export const FIXTURE_TAG = "eval-fixture";
export const FIXTURE_SOURCE_NOTE = "Fake data for Jack's eval";

export type KnowledgeFixture = {
  id: string;
  versionId: string;
  title: string;
  body: string;
  tags: string[];
  /** What the entry's age counts from when it isn't reviewed */
  sourceDate: Date;
  /** Reviewed when seeded (fresh), or not (its age counts from sourceDate) */
  reviewed: boolean;
};

export async function seedKnowledgeFixtures({ prisma, now }: Pick<SeedContext, "prisma" | "now">, fixtures: KnowledgeFixture[]): Promise<string> {
  for (const f of fixtures) {
    const tags = [...new Set([...f.tags, FIXTURE_TAG])];
    const fields = { title: f.title, body: f.body, tags, sourceType: "MANUAL" as const, sourceNote: FIXTURE_SOURCE_NOTE, sourceUrl: null, sourceDate: f.sourceDate, ownerId: null, reviewedAt: f.reviewed ? now : null, reviewedById: null };
    await prisma.$transaction(async (tx) => {
      await tx.knowledgeEntry.upsert({
        where: { id: f.id },
        create: { id: f.id, ...fields, createdAt: f.sourceDate },
        update: { ...fields, archivedAt: null },
      });
      await tx.knowledgeEntryVersion.deleteMany({ where: { entryId: f.id, id: { not: f.versionId } } });
      const version = { title: f.title, body: f.body, tags, via: "seed", roomId: null, editedById: null, createdAt: f.sourceDate };
      await tx.knowledgeEntryVersion.upsert({ where: { id: f.versionId }, create: { id: f.versionId, entryId: f.id, ...version }, update: version });
    });
  }
  return `${fixtures.length} knowledge ${fixtures.length === 1 ? "entry" : "entries"}`;
}
