import { z } from "zod"
import { prisma } from "@/server/db"
import { checkInUser } from "@/server/services/attendance.service"
import { ProposalInputError, StaleProposalError } from "../errors"
import type { ProposalKind, ProposalPerson, ProposalRow } from "../types"
import { matchName, type NameCandidate } from "./names"
import { plural, revalidate } from "./shared"

/**
 * attendance.checkin (design §4.3): check people in at an event from a list of names (a sign-in sheet,
 * a message). The server matches each name to the event's registered and waitlisted people first, then to
 * every member (./names.ts: case, accents, nicknames, handles, emails). The card lists:
 * - matched names, picked;
 * - ambiguous names, one row per member it could be, none picked: the officer ticks the right one;
 * - names with no match, which can't be checked in.
 * People already checked in aren't rows; the card names them. Apply records each picked check-in through
 * the attendance service (as a manual check-in by the applying officer), which skips anyone already in.
 *
 * Row ids are "<name index>:<user id>" ("…:none" without a match), so a pick says exactly who it checks in.
 */

export const attendanceCheckinSchema = z.object({
  eventId: z.string().trim().min(1).max(64).describe("The event's id (Event.id), from events_overview"),
  names: z.array(z.string().trim().min(1).max(120)).min(1).max(300).describe("The people to check in, as written: names, handles (@…) or emails, one per item"),
})

export type AttendanceCheckin = z.infer<typeof attendanceCheckinSchema>

type Person = NameCandidate & { list?: "registered" | "waitlisted" }

const NO_MATCH = "none"

function where(person: Person): string {
  return person.list === "registered" ? "registered" : person.list === "waitlisted" ? "on the waitlist" : "not registered"
}

const describe = (person: Person) => `${person.displayName} (@${person.handle}) · ${where(person)}`

const savedBefore = z.object({ eventTitle: z.string(), matched: z.array(z.string()) })

export const attendanceCheckinKind: ProposalKind<AttendanceCheckin> = {
  kind: "attendance.checkin",
  tool: "propose_import",
  description:
    "attendance.checkin: check people in at an event from a list of names (a sign-in sheet, a photo of one, or names in a message). Give the event's id (events_overview) and the names as written; handles and emails work too. The server matches them to the event's registrations and to members; the card shows matched, ambiguous (with who it could be) and unmatched names, and officers tick who to check in. Include every name still to check in: a newer proposal for the same event replaces this one.",
  schema: attendanceCheckinSchema,
  targetType: "EVENT",
  permission: "officer",

  async prepare(p) {
    const event = await prisma.event.findUnique({ where: { id: p.eventId }, select: { id: true, title: true } })
    if (!event) throw new ProposalInputError(`There's no event with id ${p.eventId}. Find it with events_overview.`)

    const [registrations, members, attended] = await Promise.all([
      prisma.eventRegistration.findMany({
        where: { eventId: event.id, status: { in: ["REGISTERED", "WAITLISTED"] }, user: { status: { not: "deleted" } } },
        select: { status: true, user: { select: { id: true, displayName: true, handle: true, email: true } } },
      }),
      prisma.user.findMany({ where: { status: { not: "deleted" } }, select: { id: true, displayName: true, handle: true, email: true } }),
      prisma.eventAttendance.findMany({ where: { eventId: event.id }, select: { userId: true } }),
    ])
    const list: Person[] = registrations.map((r) => ({ ...r.user, list: r.status === "REGISTERED" ? "registered" : "waitlisted" }))
    const onList = new Map(list.map((person) => [person.id, person]))
    const everyone: Person[] = members.map((member) => onList.get(member.id) ?? member)
    const checkedIn = new Set(attended.map((a) => a.userId))

    const rows: ProposalRow[] = []
    const already: ProposalPerson[] = []
    const matchedBy = new Map<string, string>()
    const seen = new Set<string>()
    let matched = 0
    let ambiguous = 0
    let unmatched = 0
    for (const [i, name] of p.names.entries()) {
      const key = name.trim().toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const found = matchName(name, list, everyone)
      if (found.kind === "matched") {
        const person = found.member
        if (checkedIn.has(person.id)) {
          already.push({ name, detail: `${person.displayName} is already checked in` })
          continue
        }
        const earlier = matchedBy.get(person.id)
        if (earlier) {
          rows.push({ id: `${i}:${person.id}`, label: name, detail: `${describe(person)}. Same member as “${earlier}”`, status: "ambiguous" })
          ambiguous++
          continue
        }
        matchedBy.set(person.id, name)
        rows.push({ id: `${i}:${person.id}`, label: name, detail: describe(person), status: "matched" })
        matched++
      } else if (found.kind === "ambiguous") {
        ambiguous++
        for (const person of found.candidates) {
          rows.push({ id: `${i}:${person.id}`, label: name, detail: `Could be ${describe(person)}${checkedIn.has(person.id) ? ", already checked in" : ""}`, status: "ambiguous" })
        }
      } else {
        unmatched++
        rows.push({ id: `${i}:${NO_MATCH}`, label: name, detail: "No member matches. Check the spelling, or give their handle or email.", status: "unmatched" })
      }
    }
    if (!rows.length) throw new ProposalInputError(`Everyone named is already checked in at “${event.title}”.`)
    if (!matched && !ambiguous) {
      const names = rows.map((r) => r.label)
      throw new ProposalInputError(`No member matches ${names.length === 1 ? "this name" : "these names"}: ${names.join(", ")}. Check the spelling, or give their handles or emails.`)
    }

    const sentences = [
      `Applying it checks in the people left ticked below at “${event.title}”, as manual check-ins by the officer who applies it.`,
      [matched ? `${plural(matched, "name")} matched` : null, ambiguous ? `${plural(ambiguous, "name")} could be more than one member (tick the right one)` : null, unmatched ? `${plural(unmatched, "name")} matched nobody and can't be checked in` : null].filter(Boolean).join(", ") + ".",
      already.length ? `${plural(already.length, "person is", "people are")} already checked in.` : null,
    ].filter(Boolean)
    return {
      before: { eventTitle: event.title, matched: rows.filter((r) => r.status === "matched").map((r) => r.id) },
      targetId: event.id,
      view: {
        title: `Check in ${plural(matched + ambiguous + unmatched, "person", "people")} at “${event.title}”`,
        summary: sentences.join(" "),
        diff: [],
        rows,
        ...(already.length ? { people: already } : {}),
        links: [{ title: "Registration and check-in", url: `/admin/events/${event.id}/manage` }],
      },
    }
  },

  async checkStale(p, before) {
    const saved = savedBefore.safeParse(before)
    if (!saved.success) return "The proposal's copy is missing. Ask Jack to propose it again."
    return (await prisma.event.findUnique({ where: { id: p.eventId }, select: { id: true } })) ? null : `The event “${saved.data.eventTitle}” was deleted.`
  },

  async apply(p, ctx) {
    const saved = savedBefore.safeParse(ctx.before)
    if (!saved.success) throw new StaleProposalError("The proposal's copy is missing. Ask Jack to propose it again.")
    // Without picks, only the matched names: an ambiguous row is applied only when an officer ticks it
    const picked = ctx.selectedRows ?? saved.data.matched
    const userIds: string[] = []
    const applied: string[] = []
    let skipped = 0
    for (const rowId of picked) {
      const userId = rowId.slice(rowId.indexOf(":") + 1)
      if (!userId || userId === NO_MATCH) {
        skipped++
        continue
      }
      applied.push(rowId)
      if (!userIds.includes(userId)) userIds.push(userId)
    }
    if (!userIds.length) throw new Error("None of the ticked names matched a member, so nobody was checked in.")

    const live = new Set((await prisma.user.findMany({ where: { id: { in: userIds }, status: { not: "deleted" } }, select: { id: true } })).map((u) => u.id))
    let added = 0
    let wereIn = 0
    let gone = 0
    for (const userId of userIds) {
      if (!live.has(userId)) {
        gone++
        continue
      }
      const result = await checkInUser(p.eventId, userId, "MANUAL", ctx.officer.userId, ctx.auditMetadata)
      if (result.alreadyCheckedIn) wereIn++
      else added++
    }
    revalidate([`/admin/events/${p.eventId}/manage`])

    const extra = [wereIn ? `${plural(wereIn, "was", "were")} already checked in` : null, skipped ? `${plural(skipped, "name")} with no match skipped` : null, gone ? `${plural(gone, "account")} no longer there` : null].filter(Boolean)
    return {
      summary: `Checked in ${plural(added, "person", "people")} at “${saved.data.eventTitle}”${extra.length ? ` (${extra.join("; ")})` : ""}.`,
      links: [{ title: "Registration and check-in", url: `/admin/events/${p.eventId}/manage` }],
      appliedRows: applied,
      counts: { checkedIn: added, alreadyIn: wereIn, skipped },
    }
  },
}
