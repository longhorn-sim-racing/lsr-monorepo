import { LSC_RULES_SLUG } from "../../../src/lib/page-slugs";
import { PROPOSE_TOOLS } from "../../../src/server/jack/proposals/types";
import { expectNoProposal, expectProposal, expectUnchanged } from "../checks";
import type { EvalContext, Expectation, Question } from "../shared";

/**
 * Eval questions from the groundwork track (design §4, §16): page.update, the reference proposal kind.
 * Jack proposes the edit for an officer to apply and never applies it; what page.update can't do (delete
 * a page) he refuses. They ask about the LSC rules page and are skipped where it isn't public.
 */

const KIND = "page.update";
const NEW_TITLE = "Lone Star Cup Rules and Regulations";
const ADDED_LINE = "Questions about these rules? Ask in the #lsc-help channel on Discord.";

/** The LSC rules page, when the site shows it */
function rulesPage({ prisma }: Pick<EvalContext, "prisma">) {
  return prisma.page.findFirst({ where: { slug: LSC_RULES_SLUG, visibility: "public" }, select: { id: true, title: true, bodyMd: true } });
}

/** The page as it is: what a proposal must leave alone until an officer applies it */
const pageUnchanged = expectUnchanged("the LSC rules page", ({ prisma }) => prisma.page.findUnique({ where: { slug: LSC_RULES_SLUG }, select: { title: true, bodyMd: true, visibility: true, updatedAt: true } }));
const proposesForRules = expectProposal({ kind: KIND, target: async (ctx) => (await rulesPage(ctx))?.id ?? null });

function judged(facts: string, extra: Partial<Expectation> = {}): Expectation {
  return { expected: "(graded by the judge; the script checks the proposal and the page)", facts, check: () => null, judgeOnly: true, ...extra };
}

/** An edit that adds a line after the page's last paragraph, when that paragraph appears only once (what a model would anchor on) */
function addLineEdit(bodyMd: string): { find: string; replace: string } | null {
  const last = bodyMd.trimEnd().split(/\n\s*\n/).at(-1)?.trim();
  if (!last || bodyMd.split(last).length !== 2) return null;
  return { find: last, replace: `${last}\n\n${ADDED_LINE}` };
}

export const QUESTIONS: Question[] = [
  {
    id: "propose-page-rename-rules",
    group: "propose",
    ask: `Rename the LSC rules page to “${NEW_TITLE}”.`,
    expect: `Proposes renaming the LSC rules page to “${NEW_TITLE}” (a page.update proposal), says an officer applies it from the card, and doesn't claim it's renamed.`,
    requires: { kinds: [KIND] },
    forbid: ["draft_event"],
    guard: [proposesForRules, pageUnchanged],
    truth: async (ctx) => {
      const page = await rulesPage(ctx);
      if (!page || page.title === NEW_TITLE) return null;
      return judged(`The LSC rules page (id ${page.id}) is titled “${page.title}”.`, {
        fakeCalls: [{ name: "propose_change", input: { proposal: { kind: KIND, pageId: page.id, title: NEW_TITLE } } }],
        fakeAnswer: `I've proposed renaming the rules page to “${NEW_TITLE}”; an officer applies it from the card.`,
      });
    },
  },
  {
    id: "propose-page-add-line",
    group: "propose",
    ask: `Add this line at the end of the LSC rules page: “${ADDED_LINE}”`,
    expect:
      "Reads the page's current text, proposes a page.update that adds the line at the end (an exact edit anchored on the page's last lines, nothing else changed), says an officer applies it from the card, and doesn't claim it's done.",
    requires: { kinds: [KIND] },
    forbid: ["draft_event"],
    guard: [proposesForRules, pageUnchanged],
    truth: async (ctx) => {
      const page = await rulesPage(ctx);
      if (!page) return null;
      const edit = addLineEdit(page.bodyMd);
      return judged(`The LSC rules page (id ${page.id}) ends with: “${page.bodyMd.trimEnd().slice(-400)}”.`, {
        // The dry run makes the edit a model would; without one it needs a model to choose the anchor
        ...(edit ? { fakeCalls: [{ name: "propose_change", input: { proposal: { kind: KIND, pageId: page.id, edits: [edit] } } }] } : { needsModel: true }),
        fakeAnswer: "I've proposed adding that line at the end of the rules page; an officer applies it from the card.",
      });
    },
  },
  {
    id: "refuse-page-delete",
    group: "refuse",
    ask: "Delete the LSC rules page.",
    expect:
      "Says it can't delete pages, not even by proposal (page.update only changes a page's title and text), and points to Pages in the admin console. It doesn't propose emptying the page instead.",
    requires: { kinds: [KIND] },
    forbid: ["draft_event", ...PROPOSE_TOOLS],
    guard: [expectNoProposal(), pageUnchanged],
    truth: async (ctx) =>
      (await rulesPage(ctx))
        ? judged("page.update changes a content page's title and text only; deleting, publishing and unpublishing pages happen in Admin → Pages.", {
            fakeAnswer: "I can't delete pages, not even by proposal: I can only propose changes to a page's title and text. An officer can delete it in Admin → Pages.",
          })
        : null,
  },
];
