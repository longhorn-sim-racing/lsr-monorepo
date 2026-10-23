/**
 * LOCAL ONLY: checks the sponsors-meetings track (#188) against the real local Postgres, where the unit
 * tests use fakes: the services' row locks and conditional writes, the stage-change log and last
 * contact, decisions reaching the decision log (and the search index, through its trigger), what a
 * meeting's delete keeps, and the four proposal kinds end to end through the real proposal framework
 * (propose, partial apply, a stale apply), plus the queries, the digest checks and the two list tools.
 *
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres pnpm --filter @lsr/platform exec tsx scripts/check-sponsors-meetings.ts
 *
 * Refuses unless DATABASE_URL points at 127.0.0.1 or localhost. Writes two throwaway officers, one room,
 * and prospects, meetings, action items and knowledge entries tagged with this run's marker (with their
 * audit entries), and deletes them all at the end, pass or fail. Nothing is broadcast.
 */
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

for (const file of [".env.local", ".env"]) {
  const path = resolve(process.cwd(), file)
  if (!existsSync(path)) continue
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (process.env[key] === undefined) process.env[key] = value
  }
}
let host = ""
try {
  host = new URL(process.env.DATABASE_URL ?? "").hostname
} catch {}
if (!["127.0.0.1", "localhost"].includes(host)) {
  console.error(`Refusing to run: DATABASE_URL points at "${host || "nothing"}", not the local database.`)
  process.exit(1)
}
// db.ts logs every query unless NODE_ENV is production; keep the run readable
;(process.env as Record<string, string | undefined>).NODE_ENV ??= "production"

const MARK = `chk${randomBytes(4).toString("hex")}`
let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail: unknown = "") {
  if (ok) pass++
  else fail++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`)
}

async function main() {
  const { prisma } = await import("../src/server/db")
  const sponsors = await import("../src/server/services/sponsor.service")
  const meetings = await import("../src/server/services/meeting.service")
  const proposals = await import("../src/server/jack/proposals/service")
  const { findProposalKind } = await import("../src/server/jack/proposals/registry")
  const { listProspects } = await import("../src/server/queries/sponsor-prospects")
  const { listActionItems, getMeetingDetail } = await import("../src/server/queries/meetings")
  const { overdueActionItems, quietProspects } = await import("../src/server/automation/checks/sponsors-meetings")
  const { sponsorsListTool } = await import("../src/server/jack/tools/sponsors-list")
  const { meetingsListTool } = await import("../src/server/jack/tools/meetings-list")
  const { dueDateValue, meetingTimeValue } = await import("../src/lib/meetings")
  const { centralDate } = await import("../src/server/jack/tools/time")

  const users: string[] = []
  const roomId = `room-${MARK}`
  const room2Id = `room2-${MARK}`
  const deps = { ...proposals.defaultProposalDeps, broadcast: async () => {}, findKind: findProposalKind }
  const now = new Date()
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000)

  try {
    console.log(`Marker ${MARK}\n`)
    const officerRole = await prisma.role.findUnique({ where: { key: "officer" } })
    if (!officerRole) throw new Error("No officer role in this database")
    const makeOfficer = async (key: string) => {
      const user = await prisma.user.create({ data: { email: `${MARK}-${key}@example.test`, handle: `${MARK}-${key}`, displayName: `Check ${key} ${MARK}` } })
      users.push(user.id)
      await prisma.userRole.create({ data: { userId: user.id, roleId: officerRole.id } })
      return user
    }
    const ana = await makeOfficer("ana")
    const ben = await makeOfficer("ben")
    const member = await prisma.user.create({ data: { email: `${MARK}-member@example.test`, handle: `${MARK}-member`, displayName: `Check member ${MARK}` } })
    users.push(member.id)
    await prisma.jackRoom.create({ data: { id: roomId, title: `Check ${MARK}`, createdById: ana.id } })
    const actor = { userId: ana.id }

    console.log("Sponsor service")
    const apex = await sponsors.createProspect({ company: `Apex ${MARK}`, stage: "contacted", ownerId: ana.id, contactEmail: `jordan@${MARK}.example`, notes: "Private notes" }, actor)
    check("adds a prospect with an officer owner", apex.ok, apex)
    if (!apex.ok) return
    const dup = await sponsors.createProspect({ company: `apex ${MARK.toUpperCase()}, Inc.` }, actor)
    check("refuses the same company again (case, suffix)", !dup.ok && dup.reason === "duplicate" && dup.duplicateId === apex.prospect.id, dup)
    const notOfficer = await sponsors.createProspect({ company: `Bolt ${MARK}`, ownerId: member.id }, actor)
    check("refuses a member who isn't an officer as owner", !notOfficer.ok && notOfficer.reason === "owner", notOfficer)
    const audit = await prisma.auditLog.findFirst({ where: { entityType: "SPONSOR_PROSPECT", entityId: apex.prospect.id, actionType: "CREATE" } })
    check("audits the create without the contact's details or notes", Boolean(audit) && !JSON.stringify(audit?.after).includes("jordan@") && !JSON.stringify(audit?.after).includes("Private notes"), audit?.after)

    const raced = await Promise.all([
      sponsors.updateProspect(apex.prospect.id, { stage: "talking" }, actor, { expected: { stage: "contacted" } }),
      sponsors.updateProspect(apex.prospect.id, { stage: "declined" }, actor, { expected: { stage: "contacted" } }),
    ])
    check("of two changes from the same read, exactly one lands (row lock)", raced.filter((r) => r.ok && r.changed.length).length === 1 && raced.filter((r) => !r.ok && r.reason === "changed").length === 1, raced.map((r) => (r.ok ? r.changed : r.reason)))
    const stageLog = await prisma.sponsorActivity.count({ where: { prospectId: apex.prospect.id, type: "stage_change" } })
    check("the stage change is in the activity log", stageLog === 1, stageLog)

    const met = ago(2)
    const logged = await sponsors.logProspectActivity(apex.prospect.id, { type: "meeting", summary: "Intro meeting", occurredAt: met }, actor, { nextStep: "Send the deck", nextStepDue: dueDateValue(centralDate(ago(-5))) })
    const afterLog = await prisma.sponsorProspect.findUnique({ where: { id: apex.prospect.id } })
    check("logging a meeting moves the last contact and sets the next step", logged.ok && afterLog?.lastContactAt?.getTime() === met.getTime() && afterLog?.nextStep === "Send the deck", afterLog)
    await sponsors.logProspectActivity(apex.prospect.id, { type: "note", summary: "Old note", occurredAt: ago(30) }, actor)
    const afterNote = await prisma.sponsorProspect.findUnique({ where: { id: apex.prospect.id } })
    check("a note leaves the last contact alone", afterNote?.lastContactAt?.getTime() === met.getTime(), afterNote?.lastContactAt)

    // A quiet one: contacted, last touched 30 days ago
    const bolt = await sponsors.createProspect({ company: `Bolt ${MARK}`, stage: "contacted" }, actor)
    if (!bolt.ok) throw new Error(bolt.error)
    await prisma.sponsorProspect.update({ where: { id: bolt.prospect.id }, data: { createdAt: ago(40), lastContactAt: ago(30) } })

    console.log("\nMeeting service and the decision log")
    const meeting = await meetings.createMeeting({ title: `Board ${MARK}`, type: "board", heldAt: meetingTimeValue(centralDate(ago(3)), "18:30"), agendaMd: "1. Sponsors" }, actor, { roomId })
    check("records a meeting", meeting.ok, meeting)
    if (!meeting.ok) return
    const decision = await meetings.addDecision(meeting.meeting.id, { text: `Keep the four sponsor tiers ${MARK}.` }, actor, { roomId })
    check("a decision reaches the decision log", decision.ok && decision.knowledge.ok, decision)
    if (decision.ok && decision.knowledge.ok) {
      const entry = await prisma.knowledgeEntry.findUnique({ where: { id: decision.knowledge.entryId }, include: { versions: true } })
      check("tagged decision and the meeting's type, reviewed, dated the meeting, linked back", Boolean(entry && entry.tags.includes("decision") && entry.tags.includes("board") && entry.reviewedAt && entry.sourceDate?.getTime() === meeting.meeting.heldAt.getTime() && entry.sourceUrl === `/admin/meetings/${meeting.meeting.id}`), entry)
      check("its version keeps the room (the eval cleanup finds it)", entry?.versions[0]?.roomId === roomId, entry?.versions)
      const indexed = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM "JackSearchDoc" WHERE source = 'knowledge' AND "sourceId" = ${decision.knowledge.entryId}`
      check("the search index has it (trigger)", Number(indexed[0]?.n ?? 0) === 1, indexed)
    }
    const overdue = await meetings.createActionItem({ text: `Send the packet ${MARK}`, ownerId: ben.id, dueAt: dueDateValue(centralDate(ago(4))) }, actor, { meetingId: meeting.meeting.id })
    const later = await meetings.createActionItem({ text: `Book the room ${MARK}`, ownerId: ben.id, dueAt: dueDateValue(centralDate(ago(-3))) }, actor, { meetingId: meeting.meeting.id })
    check("adds action items", overdue.ok && later.ok, [overdue, later])
    if (!overdue.ok || !later.ok) return
    const done = await meetings.updateActionItem(later.item.id, { status: "done" }, actor)
    check("marking done stamps doneAt", done.ok && Boolean(done.item.doneAt), done)
    const reopened = await meetings.updateActionItem(later.item.id, { status: "open" }, actor)
    check("reopening clears it", reopened.ok && reopened.item.doneAt === null, reopened)

    console.log("\nQueries, checks and tools")
    const prospects = (await listProspects(now)).filter((p) => p.company.includes(MARK))
    check("lists the prospects, the quiet one flagged", prospects.length === 2 && prospects.find((p) => p.id === bolt.prospect.id)?.quiet === true && prospects.find((p) => p.id === apex.prospect.id)?.quiet === false, prospects.map((p) => [p.company, p.quiet]))
    const items = await listActionItems({ status: "open", ownerId: ben.id }, now)
    check("lists the owner's open items, overdue first", items[0]?.id === overdue.item.id && items[0]?.overdue === true && items[1]?.id === later.item.id, items.map((i) => [i.text, i.overdue]))
    const detail = await getMeetingDetail(meeting.meeting.id, now)
    check("the meeting's page has its decision and items", detail?.decisions.length === 1 && detail.actionItems.length === 2 && detail.room?.id === roomId, detail)
    const overdueCheck = await overdueActionItems.run({ now })
    check("the overdue check names the owner", overdueCheck.items.some((i) => i.title === `Check ben ${MARK}: 1 overdue`), overdueCheck.items)
    const quietCheck = await quietProspects.run({ now })
    check("the quiet check lists the quiet prospect", quietCheck.items.some((i) => i.title === `Bolt ${MARK}`), quietCheck.items)
    const ctx = { roomId, actor: { userId: ana.id, displayName: ana.displayName } }
    const listed = JSON.parse((await sponsorsListTool.run(sponsorsListTool.input.parse({ query: MARK }), ctx)).forModel)
    check("sponsors_list finds them by a word, without contact emails", listed.matching === 2 && !JSON.stringify(listed).includes("jordan@"), listed)
    const mine = JSON.parse((await meetingsListTool.run(meetingsListTool.input.parse({ show: "action_items", owner: `@${ben.handle}`, status: "overdue" }), ctx)).forModel)
    check("meetings_list finds an officer's overdue items by handle", mine.matching === 1 && mine.actionItems[0]?.id === overdue.item.id, mine)
    const decided = JSON.parse((await meetingsListTool.run(meetingsListTool.input.parse({ show: "decisions", query: `tiers ${MARK}` }), ctx)).forModel)
    check("meetings_list finds the decision by its words", decided.found === 1, decided)

    console.log("\nProposals end to end")
    const ask = { userId: ana.id, displayName: ana.displayName }
    const gray = { id: ben.id, displayName: ben.displayName }
    const upsert = await proposals.createProposal(
      { kind: "prospect.upsert", payload: { prospects: [{ company: `Crest ${MARK}`, stage: "talking", owner: ben.handle }, { prospectId: apex.prospect.id, tierInterest: "gold" }, { company: `Delta ${MARK}` }] }, roomId, proposedFor: ask },
      deps,
    )
    check("prospect.upsert proposes, changing nothing yet", upsert.ok && (await prisma.sponsorProspect.count({ where: { company: { contains: MARK } } })) === 2, upsert)
    if (upsert.ok) {
      const applied = await proposals.applyProposal(upsert.proposal.proposalId, gray, { selectedRows: ["p1", "p2"] }, deps)
      const crest = await prisma.sponsorProspect.findFirst({ where: { company: `Crest ${MARK}` } })
      const delta = await prisma.sponsorProspect.count({ where: { company: `Delta ${MARK}` } })
      const tier = (await prisma.sponsorProspect.findUnique({ where: { id: apex.prospect.id } }))?.tierInterest
      check("applying two of three rows adds one and changes one", applied.ok && crest?.ownerId === ben.id && delta === 0 && tier === "gold", applied)
      const trail = await prisma.auditLog.count({ where: { entityType: "SPONSOR_PROSPECT", metadata: { path: ["proposalId"], equals: upsert.proposal.proposalId } } })
      check("each change's audit entry names the proposal", trail === 2, trail)
    }

    const stale = await proposals.createProposal({ kind: "prospect.activity", payload: { activities: [{ prospectId: apex.prospect.id, type: "call", summary: "Follow-up call", stage: "committed" }] }, roomId, proposedFor: ask }, deps)
    check("prospect.activity proposes", stale.ok, stale)
    if (stale.ok) {
      await sponsors.updateProspect(apex.prospect.id, { stage: "dormant" }, actor)
      const outcome = await proposals.applyProposal(stale.proposal.proposalId, gray, {}, deps)
      const row = await prisma.jackProposal.findUnique({ where: { id: stale.proposal.proposalId } })
      check("goes stale when the stage changed meanwhile, logging nothing", !outcome.ok && row?.status === "STALE" && (await prisma.sponsorActivity.count({ where: { prospectId: apex.prospect.id, summary: "Follow-up call" } })) === 0, row?.status)
    }

    const techPayload = (title: string) => ({
      title,
      type: "tech",
      date: centralDate(now),
      decisions: [{ text: `Launch the bot in November ${MARK}.` }, { text: `Skip the poll ${MARK}.` }],
      actionItems: [{ text: `Write the privacy note ${MARK}`, owner: ben.handle, due: centralDate(ago(-4)) }],
    })
    const draft = await proposals.createProposal({ kind: "meeting.record", payload: techPayload(`Tech draft ${MARK}`), roomId, proposedFor: ask }, deps)
    const record = await proposals.createProposal({ kind: "meeting.record", payload: techPayload(`Tech ${MARK}`), roomId, proposedFor: ask }, deps)
    check("meeting.record proposes", record.ok, record)
    check("a corrected new meeting (same day and type) supersedes the earlier card", draft.ok && record.ok && record.superseded.includes(draft.proposal.proposalId), record.ok ? record.superseded : record)
    // The same meeting proposed in another room before either is applied: both cards stand
    await prisma.jackRoom.create({ data: { id: room2Id, title: `Check 2 ${MARK}`, createdById: ana.id } })
    const twin = await proposals.createProposal({ kind: "meeting.record", payload: techPayload(`tech ${MARK}`), roomId: room2Id, proposedFor: ask }, deps)
    if (record.ok && twin.ok) {
      const picks = { selectedRows: ["m", "d1", "a1"] }
      const raced = await Promise.all([proposals.applyProposal(record.proposal.proposalId, gray, picks, deps), proposals.applyProposal(twin.proposal.proposalId, gray, picks, deps)])
      const states = await prisma.jackProposal.findMany({ where: { id: { in: [record.proposal.proposalId, twin.proposal.proposalId] } }, select: { status: true } })
      const techs = await prisma.meeting.findMany({ where: { title: { equals: `Tech ${MARK}`, mode: "insensitive" } }, include: { decisions: true, actionItems: true } })
      check(
        "two applies of the same new meeting: one records it, the other goes stale (lock and check at apply)",
        techs.length === 1 && states.filter((s) => s.status === "APPLIED").length === 1 && states.filter((s) => s.status === "STALE").length === 1,
        { states, meetings: techs.length, raced: raced.map((r) => (r.ok ? "ok" : r.error)) },
      )
      const tech = techs[0]
      check(
        "applies the meeting with the picked decision and item",
        Boolean(tech) && tech.decisions.length === 1 && Boolean(tech.decisions[0].knowledgeEntryId) && tech.actionItems.length === 1 && tech.actionItems[0].ownerId === ben.id && [roomId, room2Id].includes(tech.actionItems[0].roomId ?? ""),
        tech,
      )
      const entry = tech?.decisions[0]?.knowledgeEntryId ? await prisma.knowledgeEntry.findUnique({ where: { id: tech.decisions[0].knowledgeEntryId } }) : null
      const provenance = entry?.provenance as { roomId?: string; tools?: { name: string; input: string }[] } | null
      check(
        "its decision-log entry is Jack's: not reviewed, with the proposal in its provenance",
        entry?.sourceType === "JACK" && entry.reviewedAt === null && [roomId, room2Id].includes(provenance?.roomId ?? "") && Boolean(provenance?.tools?.some((t) => t.name === "propose_meeting")),
        entry && { sourceType: entry.sourceType, reviewedAt: entry.reviewedAt, provenance },
      )
      if (tech) {
        const again = await proposals.createProposal(
          { kind: "meeting.record", payload: { meetingId: tech.id, decisions: [{ text: `launch the bot in november ${MARK}` }, { text: `Use the new logo ${MARK}.` }] }, roomId, proposedFor: ask },
          deps,
        )
        const added = again.ok ? await proposals.applyProposal(again.proposal.proposalId, gray, {}, deps) : again
        const decisions = await prisma.meetingDecision.findMany({ where: { meetingId: tech.id } })
        check("a decision the meeting already has is left out", added.ok && decisions.length === 2, { decisions: decisions.map((d) => d.text), added })
      }
    }

    const markDone = await proposals.createProposal({ kind: "action_item.update", payload: { items: [{ id: overdue.item.id, status: "done" }] }, roomId, proposedFor: ask }, deps)
    check("action_item.update proposes, targeting the item", markDone.ok && (await prisma.jackProposal.findUnique({ where: { id: markDone.proposal.proposalId } }))?.targetId === overdue.item.id, markDone)
    if (markDone.ok) {
      const applied = await proposals.applyProposal(markDone.proposal.proposalId, gray, {}, deps)
      const item = await prisma.actionItem.findUnique({ where: { id: overdue.item.id } })
      check("applying marks it done", applied.ok && item?.status === "done" && Boolean(item.doneAt), item)
    }

    console.log("\nDeleting")
    const kept = await meetings.deleteMeeting(meeting.meeting.id, actor)
    const orphans = await prisma.actionItem.count({ where: { id: { in: [overdue.item.id, later.item.id] }, meetingId: null } })
    const decisionsLeft = await prisma.meetingDecision.count({ where: { meetingId: meeting.meeting.id } })
    check("deleting a meeting removes its decisions and keeps its action items", kept.ok && orphans === 2 && decisionsLeft === 0, { orphans, decisionsLeft })
    const gone = await sponsors.deleteProspect(apex.prospect.id, actor)
    check("deleting a prospect removes its activity", gone.ok && (await prisma.sponsorActivity.count({ where: { prospectId: apex.prospect.id } })) === 0, gone)
  } finally {
    // Everything this run wrote, found by its marker, its room and its users
    const prospectIds = (await prisma.sponsorProspect.findMany({ where: { company: { contains: MARK } }, select: { id: true } })).map((p) => p.id)
    const meetingIds = (await prisma.meeting.findMany({ where: { title: { contains: MARK } }, select: { id: true } })).map((m) => m.id)
    const itemIds = (await prisma.actionItem.findMany({ where: { text: { contains: MARK } }, select: { id: true } })).map((i) => i.id)
    const entryIds = (await prisma.knowledgeEntry.findMany({ where: { OR: [{ title: { contains: MARK } }, { body: { contains: MARK } }] }, select: { id: true } })).map((e) => e.id)
    await prisma.meetingDecision.deleteMany({ where: { OR: [{ meetingId: { in: meetingIds } }, { text: { contains: MARK } }] } })
    await prisma.actionItem.deleteMany({ where: { id: { in: itemIds } } })
    await prisma.meeting.deleteMany({ where: { id: { in: meetingIds } } })
    await prisma.sponsorProspect.deleteMany({ where: { id: { in: prospectIds } } })
    await prisma.knowledgeEntry.deleteMany({ where: { id: { in: entryIds } } })
    await prisma.jackRoom.deleteMany({ where: { id: { in: [roomId, room2Id] } } })
    const ids = [...prospectIds, ...meetingIds, ...itemIds, ...entryIds]
    await prisma.auditLog.deleteMany({
      where: { OR: [{ entityId: { in: ids } }, { actorUserId: { in: users } }, { metadata: { path: ["roomId"], equals: roomId } }, { metadata: { path: ["roomId"], equals: room2Id } }] },
    })
    await prisma.userRole.deleteMany({ where: { userId: { in: users } } })
    await prisma.user.deleteMany({ where: { id: { in: users } } })
    const left = (await prisma.sponsorProspect.count({ where: { company: { contains: MARK } } })) + (await prisma.meeting.count({ where: { title: { contains: MARK } } })) + (await prisma.actionItem.count({ where: { text: { contains: MARK } } }))
    console.log(`\nCleaned up (${left} rows left). ${pass} passed, ${fail} failed.`)
    await prisma.$disconnect()
  }
}

main()
  .then(() => process.exit(fail ? 1 : 0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
