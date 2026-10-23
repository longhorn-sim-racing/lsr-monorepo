import type { EvalSeeder, SeedContext } from "./types";

/**
 * Fills the eval copy with the decks-rooms track's fake data before a run (pnpm jack:eval:prepare): a
 * made-up three-slide Instagram graphic (post size, no room) and an empty gallery album, for the
 * instagram.publish and gallery.add questions. Fixed ids, so running it again resets them in place.
 * Nothing is posted or uploaded: the questions only check that Jack proposes.
 */

/** The seeded rows' ids and names, which the questions look up */
export const DR_SEED = {
  /** A UUID, as deck pages and slide image links take */
  deck: "e7a1dec0-0000-4000-8000-0000000000b9",
  deckTitle: "Eval GM 2 recap",
  album: "evalseed-dr-album-graphics",
  albumTitle: "Eval graphics",
  albumSlug: "eval-graphics",
} as const;

const SLIDES = [
  { id: "evalgm2s1", html: '<section class="slide dark"><h1 class="display">GM 2 recap</h1><p class="lead">38 drivers, one very wet Spa</p></section>', notes: "Made-up eval slide." },
  { id: "evalgm2s2", html: '<section class="slide light"><h2>Podium</h2><p class="lead">Thanks to everyone who raced</p></section>' },
  { id: "evalgm2s3", html: '<section class="slide dark"><h2>Next up: GM 3</h2><p class="lead">See you Monday</p></section>' },
];

async function seed({ prisma }: SeedContext): Promise<string> {
  const content = { css: "", slides: SLIDES };
  await prisma.jackDeck.upsert({
    where: { id: DR_SEED.deck },
    create: { id: DR_SEED.deck, title: DR_SEED.deckTitle, size: "post", version: 1, roomId: null, createdById: null },
    update: { title: DR_SEED.deckTitle, size: "post", version: 1, roomId: null },
  });
  await prisma.jackDeckVersion.deleteMany({ where: { deckId: DR_SEED.deck, version: { gt: 1 } } });
  await prisma.jackDeckVersion.upsert({
    where: { deckId_version: { deckId: DR_SEED.deck, version: 1 } },
    create: { deckId: DR_SEED.deck, version: 1, summary: "Created with 3 slides (eval fixture)", content, userId: null },
    update: { summary: "Created with 3 slides (eval fixture)", content },
  });
  await prisma.galleryAlbum.upsert({
    where: { id: DR_SEED.album },
    create: { id: DR_SEED.album, title: DR_SEED.albumTitle, slug: DR_SEED.albumSlug, description: "Made-up album for Jack's eval" },
    update: { title: DR_SEED.albumTitle, slug: DR_SEED.albumSlug },
  });
  return `deck “${DR_SEED.deckTitle}” (3 slides) and album “${DR_SEED.albumTitle}”`;
}

export const SEEDERS: EvalSeeder[] = [{ name: "decks-rooms: a graphic to post and an album", run: seed }];
