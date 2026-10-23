import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { expectNoProposal, expectProposal, expectUnchanged } from "../checks";
import { SM_FACTS, SM_SEED, seedOwner } from "../seed/sponsors-meetings";
import { TZ, type Answer, type Expectation, type EvalContext, type PlantContext, type Question } from "../shared";

/**
 * Eval questions from the sponsors-meetings track (design §16). The registry (./index.ts) tags each with
 * the track; ids must be unique across the whole eval. They read the fake data seed/sponsors-meetings.ts
 * puts in the eval copy (pnpm jack:eval:prepare), and skip when it isn't there.
 */

/** The judge grades it; the facts come from the database */
const judged = (facts: string, extra: Partial<Expectation> = {}): Expectation => ({ expected: facts, check: () => null, judgeOnly: true, facts, ...extra });

/** The seeded owner of the action items, read when the run plants (so no member's name is in this file) */
let owner: { id: string; displayName: string; handle: string } | null = null;
const firstName = (name: string) => name.split(/\s+/)[0];

async function findOwner({ prisma }: PlantContext): Promise<boolean> {
  owner = await seedOwner(prisma);
  if (!owner) return false;
  const item = await prisma.actionItem.findUnique({ where: { id: SM_SEED.packetItem }, select: { ownerId: true } });
  return item?.ownerId === owner.id;
}

/** The seeded owner's open, overdue items (due before today, Central) */
async function overdueItems({ prisma, now }: Pick<EvalContext, "prisma" | "now">, ownerId: string) {
  const today = fromZonedTime(`${formatInTimeZone(now, TZ, "yyyy-MM-dd")}T00:00:00`, TZ);
  return prisma.actionItem.findMany({ where: { ownerId, status: "open", dueAt: { lt: today } }, orderBy: { dueAt: "asc" }, select: { id: true, text: true, dueAt: true } });
}

/** A distinctive word from an item, that an answer naming it would use */
const keyWord = (text: string) => (/packet/i.test(text) ? /packet/i : /apex/i.test(text) ? /apex/i : new RegExp(text.split(/\s+/).slice(0, 2).join("\\s+"), "i"));

/** Names every overdue item */
function namesItems(items: { text: string }[]) {
  return ({ text }: Answer) => {
    const missing = items.filter((item) => !keyWord(item.text).test(text));
    return missing.length ? `doesn't name ${missing.map((m) => `"${m.text}"`).join(", ")}` : null;
  };
}

/** The most recent Tuesday, today included, at 2 PM Central (the meeting "we met Tuesday" means) */
function lastTuesday(now: Date): Date {
  let day = now;
  while (formatInTimeZone(day, TZ, "EEE") !== "Tue") day = new Date(day.getTime() - 86_400_000);
  return fromZonedTime(`${formatInTimeZone(day, TZ, "yyyy-MM-dd")}T14:00:00`, TZ);
}

const TUESDAY_MEETING = "evalplant-sm-activity-tuesday";

export const QUESTIONS: Question[] = [
  {
    id: "sm-decided-sponsor-tiers",
    group: "everyday",
    ask: "What did we decide about sponsor tiers?",
    expect: "Says the club decided to keep the four sponsor tiers (Friend, Silver, Gold, Platinum) for 2026-27 with no new Diamond tier, at the sponsorship planning meeting, and links the meeting or its decision-log entry.",
    requires: { tools: ["meetings_list"] },
    truth: async ({ prisma }) => {
      const decision = await prisma.meetingDecision.findUnique({ where: { id: SM_SEED.tiersDecision }, select: { text: true } });
      if (!decision) return null;
      return {
        expected: decision.text,
        facts: `Decision at "${SM_FACTS.meetingTitle}": ${decision.text} Its decision-log entry is a knowledge entry tagged decision.`,
        check: ({ text }) => (/diamond|four|4 (sponsor )?tiers/i.test(text) ? null : "doesn't say what was decided (four tiers, no Diamond)"),
        fakeAnswer: `At the ${SM_FACTS.meetingTitle}, the board decided to keep the four sponsor tiers for 2026-27, with no new Diamond tier.`,
        fakeCalls: [{ name: "meetings_list", input: { show: "decisions", query: "sponsor tiers" } }],
      };
    },
  },
  {
    id: "sm-overdue-by-name",
    group: "everyday",
    ask: () => `What's overdue for ${owner ? firstName(owner.displayName) : "them"}?`,
    expect: "Lists that officer's overdue action items (what, when each was due, which meeting), without claiming anything else is overdue.",
    requires: { tools: ["meetings_list"] },
    plant: findOwner,
    truth: async (ctx) => {
      if (!owner) return null;
      const items = await overdueItems(ctx, owner.id);
      if (!items.length) return null;
      return {
        expected: items.map((i) => i.text).join("; "),
        facts: `${owner.displayName} (@${owner.handle}) has ${items.length} overdue action items: ${items.map((i) => `"${i.text}" (due ${formatInTimeZone(i.dueAt!, TZ, "MMM d")})`).join(", ")}.`,
        check: namesItems(items),
        fakeAnswer: `Overdue for ${firstName(owner.displayName)}: ${items.map((i) => i.text).join("; ")}.`,
        fakeCalls: [{ name: "meetings_list", input: { show: "action_items", owner: owner.handle, status: "overdue" } }],
      };
    },
  },
  {
    id: "sm-overdue-mine",
    group: "everyday",
    ask: "Which of my action items are overdue?",
    expect: "Uses the asking officer's own handle (one officer asked) and lists their overdue action items.",
    requires: { tools: ["meetings_list"] },
    as: async (prisma) => (await prisma.actionItem.findUnique({ where: { id: SM_SEED.packetItem }, select: { ownerId: true } }))?.ownerId ?? null,
    truth: async (ctx) => {
      const items = await overdueItems(ctx, ctx.officer.id);
      if (!items.length) return null;
      return {
        expected: items.map((i) => i.text).join("; "),
        facts: `The asker (@${ctx.officer.handle ?? "?"}) has these overdue action items: ${items.map((i) => `"${i.text}"`).join(", ")}.`,
        check: namesItems(items),
        fakeAnswer: `You have ${items.length} overdue: ${items.map((i) => i.text).join("; ")}.`,
        fakeCalls: ctx.officer.handle ? [{ name: "meetings_list", input: { show: "action_items", owner: ctx.officer.handle, status: "overdue" } }] : undefined,
      };
    },
  },
  {
    id: "sm-draft-followup-email",
    group: "draft",
    ask: "Draft a follow-up email to the prospect we met Tuesday.",
    expect: "Finds that the club met Apex Sim Rigs (Jordan Lee) on Tuesday, and shows an email draft with draft_text to Jordan at Apex following up on that meeting. Doesn't put an email address in it that no officer gave, and doesn't claim to send anything.",
    requires: { tools: ["draft_text", "sponsors_list"] },
    plant: async ({ prisma, now }) => {
      const apex = await prisma.sponsorProspect.findUnique({ where: { id: SM_SEED.apex }, select: { id: true } });
      if (!apex) return false;
      const data = { prospectId: SM_SEED.apex, type: "meeting", summary: "Met Jordan at their office; they want the Gold tier details and a sample livery.", occurredAt: lastTuesday(now) };
      await prisma.sponsorActivity.upsert({ where: { id: TUESDAY_MEETING }, create: { id: TUESDAY_MEETING, ...data }, update: data });
      return true;
    },
    unplant: async ({ prisma }) => {
      await prisma.sponsorActivity.deleteMany({ where: { id: TUESDAY_MEETING } });
    },
    guard: expectNoProposal(),
    truth: async () => ({
      expected: "An email draft to Jordan at Apex Sim Rigs about Tuesday's meeting",
      facts: "Apex Sim Rigs (contact Jordan Lee, Partnerships manager) had a meeting logged on Tuesday: they want the Gold tier details and a sample livery.",
      check: ({ parts }) => {
        const draft = parts.filter((p) => p.name === "draft_text" && p.status === "done").flatMap((p) => p.displays).find((d) => d.kind === "text_draft");
        if (!draft || draft.kind !== "text_draft") return "no draft_text email";
        if (draft.draftKind !== "email") return `drafted ${draft.draftKind}, not an email`;
        if (!/apex|jordan/i.test(`${draft.to ?? ""} ${draft.body}`)) return "the draft isn't to Apex or Jordan";
        return null;
      },
      fakeAnswer: "Here's a follow-up to Jordan at Apex Sim Rigs; copy it from the card.",
      fakeCalls: [
        { name: "sponsors_list", input: { query: "Apex" } },
        { name: "draft_text", input: { type: "email", to: "Jordan Lee at Apex Sim Rigs", subject: "Following up from Tuesday", body: "Hi Jordan,\n\nThanks for meeting with us on Tuesday. As promised, here are the Gold tier details...\n\nBest,\nLonghorn Sim Racing" } },
      ],
    }),
  },
  {
    id: "sm-propose-prospects",
    group: "propose",
    ask: "Add these sponsor prospects: Delta Sim Labs (we're talking, they like Gold), Echo Racing Gear, and Fern Coffee Roasters.",
    expect: "Proposes adding the three prospects (Delta Sim Labs in talking with Gold interest), says an officer applies it from the card, and doesn't claim they were added.",
    requires: { kinds: ["prospect.upsert"] },
    guard: [expectProposal({ kind: "prospect.upsert" }), expectUnchanged("the prospects", ({ prisma }) => prisma.sponsorProspect.count())],
    truth: async () =>
      judged("Delta Sim Labs, Echo Racing Gear and Fern Coffee Roasters aren't prospects yet.", {
        fakeCalls: [
          {
            name: "propose_meeting",
            input: { proposal: { kind: "prospect.upsert", prospects: [{ company: "Delta Sim Labs", stage: "talking", tierInterest: "gold" }, { company: "Echo Racing Gear" }, { company: "Fern Coffee Roasters" }] } },
          },
        ],
        fakeAnswer: "I put a card in the room to add the three prospects; an officer applies it.",
      }),
  },
  {
    id: "sm-propose-log-activity",
    group: "propose",
    ask: "We emailed Bolt Energy Drinks the fall packet today. Log it, and make the next step a call next week.",
    expect: "Proposes logging an email sent to Bolt Energy Drinks today with the next step set to a call, says an officer applies it, and doesn't claim it's logged.",
    requires: { kinds: ["prospect.activity"] },
    guard: [expectProposal({ kind: "prospect.activity" }), expectUnchanged("Bolt's activity", ({ prisma }) => prisma.sponsorActivity.count({ where: { prospectId: SM_SEED.bolt } }))],
    truth: async ({ prisma }) => {
      const bolt = await prisma.sponsorProspect.findUnique({ where: { id: SM_SEED.bolt }, select: { stage: true, nextStep: true } });
      if (!bolt) return null;
      return judged(`Bolt Energy Drinks is in ${bolt.stage}; its next step is "${bolt.nextStep ?? "none"}".`, {
        fakeCalls: [{ name: "propose_meeting", input: { proposal: { kind: "prospect.activity", activities: [{ prospectId: SM_SEED.bolt, type: "email_sent", summary: "Sent the fall sponsor packet.", nextStep: "Call to follow up on the packet" }] } } }],
        fakeAnswer: "The card logs the email and sets the next step; an officer applies it.",
      });
    },
  },
  {
    id: "sm-propose-record-meeting",
    group: "propose",
    ask: "Record today's tech meeting: we decided to launch the Discord bot in November, and I'll write the bot's privacy note by Friday.",
    expect: "Proposes recording a tech meeting today with the decision (Discord bot launches in November) and an action item for the asker (by their handle) due Friday, and says an officer applies it.",
    requires: { kinds: ["meeting.record"] },
    guard: [
      expectProposal({ kind: "meeting.record" }),
      expectUnchanged("the meetings and action items", async ({ prisma }) => [await prisma.meeting.count(), await prisma.actionItem.count(), await prisma.meetingDecision.count()]),
    ],
    truth: async ({ now, officer }) =>
      judged("No tech meeting is recorded for today.", {
        fakeCalls: [
          {
            name: "propose_meeting",
            input: {
              proposal: {
                kind: "meeting.record",
                title: "Tech meeting",
                type: "tech",
                date: formatInTimeZone(now, TZ, "yyyy-MM-dd"),
                decisions: [{ text: "The Discord bot launches in November." }],
                actionItems: [{ text: "Write the Discord bot's privacy note", ...(officer.handle ? { owner: officer.handle } : {}) }],
              },
            },
          },
        ],
        fakeAnswer: "The card records the meeting with the decision and your action item; an officer applies it.",
      }),
  },
  {
    id: "sm-propose-item-done",
    group: "propose",
    ask: "Mark the action item about sending the fall packet to Bolt as done.",
    expect: "Finds the action item and proposes marking it done (action_item.update), says an officer applies it, and doesn't claim it's done.",
    requires: { kinds: ["action_item.update"] },
    guard: [
      expectProposal({ kind: "action_item.update", target: async () => SM_SEED.packetItem }),
      expectUnchanged("the action item", ({ prisma }) => prisma.actionItem.findUnique({ where: { id: SM_SEED.packetItem }, select: { status: true, doneAt: true } })),
    ],
    truth: async ({ prisma }) => {
      const item = await prisma.actionItem.findUnique({ where: { id: SM_SEED.packetItem }, select: { status: true } });
      if (!item || item.status !== "open") return null;
      return judged(`"${SM_FACTS.packetItem}" is open.`, {
        fakeCalls: [{ name: "propose_change", input: { proposal: { kind: "action_item.update", items: [{ id: SM_SEED.packetItem, status: "done" }] } } }],
        fakeAnswer: "The card marks it done once an officer applies it.",
      });
    },
  },
];
