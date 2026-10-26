import type { EvalSeeder, SeedContext } from "./types";

/**
 * Fake sponsor prospects, a meeting with decisions (and their decision-log entries) and action items,
 * for the sponsors-meetings questions. Every company, person and address here is made up (reserved
 * *.example domains). The action items belong to the eval copy's first officer, found when it runs, so
 * no member's name is written here. Rows have fixed ids, so running it again updates them in place.
 */

const DAY = 86_400_000;

/** The seeded rows' ids, which the questions look up */
export const SM_SEED = {
  apex: "evalseed-sm-prospect-apex",
  bolt: "evalseed-sm-prospect-bolt",
  crest: "evalseed-sm-prospect-crest",
  apexEmail: "evalseed-sm-activity-apex-email",
  boltEmail: "evalseed-sm-activity-bolt-email",
  meeting: "evalseed-sm-meeting-sponsorship",
  tiersDecision: "evalseed-sm-decision-tiers",
  packetDecision: "evalseed-sm-decision-packet",
  tiersEntry: "evalseed-sm-knowledge-tiers",
  packetEntry: "evalseed-sm-knowledge-packet",
  packetItem: "evalseed-sm-item-packet",
  apexItem: "evalseed-sm-item-apex",
  doneItem: "evalseed-sm-item-done",
} as const;

export const SM_FACTS = {
  meetingTitle: "Sponsorship planning meeting",
  tiersDecision: "Keep the four sponsor tiers (Friend, Silver, Gold, Platinum) for 2026-27; no new Diamond tier.",
  packetDecision: "Every pitch goes out with the fall sponsor packet; no custom decks for asks under Gold.",
  packetItem: "Send the fall sponsor packet to Bolt Energy Drinks",
  apexItem: "Follow up with Apex Sim Rigs about the Gold tier",
};

/** The officer the seeded action items belong to: the eval copy's first officer or admin by account age */
export async function seedOwner(prisma: SeedContext["prisma"]) {
  return prisma.user.findFirst({
    where: { status: { not: "deleted" }, roles: { some: { role: { key: { in: ["officer", "admin"] } } } } },
    orderBy: { createdAt: "asc" },
    select: { id: true, displayName: true, handle: true },
  });
}

async function seed({ prisma, now }: SeedContext): Promise<string> {
  const owner = await seedOwner(prisma);
  if (!owner) return "no officers in the eval copy; nothing seeded";
  const ago = (days: number) => new Date(now.getTime() - days * DAY);

  const prospects = [
    {
      id: SM_SEED.apex,
      company: "Apex Sim Rigs",
      website: "https://apexsimrigs.example/",
      contactName: "Jordan Lee",
      contactEmail: "jordan@apexsimrigs.example",
      contactRole: "Partnerships manager",
      stage: "talking",
      tierInterest: "gold",
      ownerId: owner.id,
      lastContactAt: ago(20),
      nextStep: "Send the Gold tier details",
      nextStepDue: ago(4),
      notes: "Builds sim cockpits; met them at the fall expo.",
    },
    {
      id: SM_SEED.bolt,
      company: "Bolt Energy Drinks",
      website: "https://boltenergy.example/",
      contactName: "Sam Ortiz",
      contactEmail: null,
      contactRole: "Campus marketing",
      stage: "contacted",
      tierInterest: "silver",
      ownerId: owner.id,
      lastContactAt: ago(30),
      nextStep: "Send the fall sponsor packet",
      nextStepDue: ago(10),
      notes: null,
    },
    {
      id: SM_SEED.crest,
      company: "Crest Wheels",
      website: "https://crestwheels.example/",
      contactName: null,
      contactEmail: null,
      contactRole: null,
      stage: "declined",
      tierInterest: null,
      ownerId: null,
      lastContactAt: ago(60),
      nextStep: null,
      nextStepDue: null,
      notes: "No sponsorship budget this year.",
    },
  ];
  for (const { id, ...data } of prospects) await prisma.sponsorProspect.upsert({ where: { id }, create: { id, ...data, createdAt: ago(90) }, update: data });

  const activities = [
    { id: SM_SEED.apexEmail, prospectId: SM_SEED.apex, type: "email_sent", summary: "Sent an intro email after the expo.", occurredAt: ago(20), byId: owner.id },
    { id: SM_SEED.boltEmail, prospectId: SM_SEED.bolt, type: "email_sent", summary: "Cold email to campus marketing.", occurredAt: ago(30), byId: owner.id },
  ];
  for (const { id, ...data } of activities) await prisma.sponsorActivity.upsert({ where: { id }, create: { id, ...data }, update: data });

  const heldAt = ago(10);
  const meeting = { title: SM_FACTS.meetingTitle, kind: "board", heldAt, agendaMd: "1. Sponsor tiers for 2026-27\n2. The fall packet\n3. Prospects", summaryMd: "We went over the sponsor tiers, the fall packet and the prospects in talks." };
  await prisma.meeting.upsert({ where: { id: SM_SEED.meeting }, create: { id: SM_SEED.meeting, ...meeting, createdById: owner.id }, update: meeting });

  // Each decision, and its decision-log entry (a knowledge entry tagged decision with one version)
  const decisions = [
    { id: SM_SEED.tiersDecision, entryId: SM_SEED.tiersEntry, title: "Keep the four sponsor tiers for 2026-27", text: SM_FACTS.tiersDecision },
    { id: SM_SEED.packetDecision, entryId: SM_SEED.packetEntry, title: "Pitches go out with the fall packet", text: SM_FACTS.packetDecision },
  ];
  for (const d of decisions) {
    const entry = {
      title: d.title,
      body: `${d.text}\n\nDecided at ${SM_FACTS.meetingTitle}.`,
      tags: ["decision", "board", "sponsors"],
      sourceType: "MANUAL" as const,
      sourceNote: `${SM_FACTS.meetingTitle} (meeting record)`,
      sourceDate: heldAt,
      sourceUrl: `/admin/meetings/${SM_SEED.meeting}`,
      reviewedAt: heldAt,
      reviewedById: owner.id,
      createdById: owner.id,
      updatedById: owner.id,
      archivedAt: null,
    };
    await prisma.knowledgeEntry.upsert({ where: { id: d.entryId }, create: { id: d.entryId, ...entry }, update: entry });
    const version = { entryId: d.entryId, title: entry.title, body: entry.body, tags: entry.tags, editedById: owner.id, via: "admin" };
    await prisma.knowledgeEntryVersion.upsert({ where: { id: `${d.entryId}-v1` }, create: { id: `${d.entryId}-v1`, ...version }, update: version });
    const decision = { meetingId: SM_SEED.meeting, text: d.text, decidedAt: heldAt, knowledgeEntryId: d.entryId };
    await prisma.meetingDecision.upsert({ where: { id: d.id }, create: { id: d.id, ...decision }, update: decision });
  }

  const items = [
    { id: SM_SEED.packetItem, text: SM_FACTS.packetItem, dueAt: ago(7), status: "open", doneAt: null },
    { id: SM_SEED.apexItem, text: SM_FACTS.apexItem, dueAt: ago(3), status: "open", doneAt: null },
    { id: SM_SEED.doneItem, text: "Update the sponsor packet's tier prices", dueAt: ago(9), status: "done", doneAt: ago(8) },
  ];
  for (const { id, ...data } of items) {
    const item = { ...data, ownerId: owner.id, meetingId: SM_SEED.meeting };
    await prisma.actionItem.upsert({ where: { id }, create: { id, ...item, createdById: owner.id }, update: item });
  }
  return `3 prospects, 1 meeting with 2 decisions, 3 action items (owner: the first officer)`;
}

/** Fills the eval copy with the sponsors-meetings track's fake data before a run (pnpm jack:eval:prepare). Must be safe to run again */
export const SEEDERS: EvalSeeder[] = [{ name: "sponsors-meetings: prospects, a meeting, decisions, action items", run: seed }];
