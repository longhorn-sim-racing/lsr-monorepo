/**
 * Design questions (#177): Jack makes a deck or a graphic, the script checks what he made (the size,
 * the slide count, and a fresh render of every slide with no layout problems), and the judge grades the
 * reply and looks at the slides themselves (jack-eval.ts passes it the renders).
 *
 * They need a real model and a local Chrome or Edge for the renders.
 */
import type { JackDeckSizeKey } from "../../src/lib/jack/decks";
import type { Answer, Expectation, Question } from "./shared";

type DeckDisplay = { kind: "deck"; deckId: string; version: number };

/** The decks a reply made or changed, each at the version it left it */
export function decksIn(answer: Answer): { deckId: string; version: number }[] {
  const latest = new Map<string, number>();
  for (const part of answer.parts) {
    for (const display of part.displays ?? []) {
      if ((display as { kind?: string }).kind !== "deck") continue;
      const { deckId, version } = display as DeckDisplay;
      latest.set(deckId, Math.max(version, latest.get(deckId) ?? 0));
    }
  }
  return [...latest].map(([deckId, version]) => ({ deckId, version }));
}

/** Checks the one deck a reply made: its size, how many slides, a fresh render of each, and anything else the question needs */
function deckCheck(want: { size: JackDeckSizeKey; min: number; max: number; html?: (html: string) => string | null }): Pick<Expectation, "check" | "verify" | "needsModel"> {
  let made: { deckId: string; version: number }[] = [];
  return {
    needsModel: true,
    check: (answer) => {
      made = decksIn(answer);
      if (!made.length) return "made no deck";
      if (made.length > 1) return `made ${made.length} decks`;
      return null;
    },
    verify: async () => {
      const [{ getDeck }, { ensureRender }] = await Promise.all([import("../../src/server/jack/decks/service"), import("../../src/server/jack/decks/renders")]);
      const deck = await getDeck(made[0].deckId);
      if (!deck) return "the deck isn't in the database";
      if (deck.size !== want.size) return `it's a ${deck.size} deck, not ${want.size}`;
      const count = deck.content.slides.length;
      if (count < want.min || count > want.max) return `it has ${count} slides, not ${want.min === want.max ? want.min : `${want.min} to ${want.max}`}`;
      const problems: string[] = [];
      for (const [i, slide] of deck.content.slides.entries()) {
        const { issues } = await ensureRender({ size: deck.size, css: deck.content.css, html: slide.html, roomId: deck.roomId });
        problems.push(...issues.map((issue) => `slide ${i + 1}: ${issue}`));
      }
      if (problems.length) return `layout problems left: ${problems.slice(0, 3).join(" ")}`;
      const html = deck.content.css + deck.content.slides.map((s) => s.html).join("\n");
      return want.html?.(html) ?? null;
    },
  };
}

const LOOK =
  "The slides must look like the club's: Kanit and Montserrat, orange on charcoal or light ground, the LSR chrome, a real club photo or a clean light layout, readable text with nothing cut off, crowded or overlapping.";

export const DESIGN: Question[] = [
  {
    id: "design-gm-deck",
    group: "design",
    ask: "Make a 4-slide deck for GM 2: Monday Oct 26, 6 to 8 PM in the Alienware Gaming Lounge. A welcome, the Lone Star Cup so far, recruiting (applications close Oct 31), and how to get involved.",
    expect: `Makes one 16:9 deck of about 4 slides covering those topics, with any club numbers from the tools (not invented), looks at the renders, links the deck and says what's left to fill in. ${LOOK}`,
    truth: async ({ lsc }) => ({
      expected: "one 16:9 deck of 3 to 5 slides with no layout problems",
      facts: lsc ? `The open LSC season is "${lsc.season.name}".` : "There's no open LSC season.",
      ...deckCheck({ size: "slides", min: 3, max: 5 }),
    }),
  },
  {
    id: "design-recruiting-story",
    group: "design",
    ask: "Make an Instagram story saying team applications are open until Oct 31 at longhornsimracing.org/apply.",
    expect: `Makes one Instagram story (1080×1920) with the deadline, the link and a QR code to it, links it, and doesn't invent other details. ${LOOK} Text stays clear of the top and bottom of the story.`,
    truth: async () => ({
      expected: "one story slide with a QR code to the apply page and no layout problems",
      ...deckCheck({
        size: "story",
        min: 1,
        max: 1,
        html: (html) => (/jack\.assets\/qr\?text=[^"']*apply/i.test(html) ? null : "no QR code to the apply page"),
      }),
    }),
  },
  {
    id: "design-standings-post",
    group: "design",
    ask: "Make a square Instagram post with the Lone Star Cup standings, top 3.",
    expect: `Looks up the standings first. If drivers have points, makes one square post with the top 3 and their points, exactly as the standings say. If nobody has points yet, says so plainly instead of inventing names, and either makes nothing or a post that clearly isn't standings. ${LOOK}`,
    truth: async ({ prisma, lsc }) => {
      if (!lsc) return null;
      const top = await prisma.entry.findMany({
        where: { seasonId: lsc.season.id, totalPoints: { gt: 0 } },
        orderBy: { totalPoints: "desc" },
        take: 3,
        select: { totalPoints: true, user: { select: { displayName: true } } },
      });
      return {
        expected: top.length ? `a square post with ${top.map((t) => `${t.user?.displayName ?? "?"} (${t.totalPoints})`).join(", ")}` : "no standings yet: says so, invents no names",
        facts: top.length ? `Top 3 in ${lsc.season.name}: ${top.map((t, i) => `${i + 1}. ${t.user?.displayName ?? "?"}, ${t.totalPoints} points`).join("; ")}.` : `Nobody in ${lsc.season.name} has points yet.`,
        needsModel: true,
        judgeOnly: true,
        check: () => null,
      };
    },
  },
];
