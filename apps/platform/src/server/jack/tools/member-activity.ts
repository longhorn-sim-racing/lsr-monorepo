import { z } from "zod"
import { prisma } from "@/server/db"
import { forModelWithList, plural, tableDisplay } from "./display"
import { centralDateInput, ct, endOfCentralDay, startOfCentralDay } from "./time"
import type { JackTool } from "./types"

/**
 * member_activity: who does the most in the club (#161), counted three ways: event registrations
 * (REGISTERED seats), check-ins at events, and races driven (race sessions they have a linked result
 * in). Added after the eval: "most active member" questions went to hand-written SQL, and a join
 * there named the wrong person.
 */

export type ActivityCounts = { registrations: number; checkIns: number; races: number; lastActive: Date | null }

const NONE: ActivityCounts = { registrations: 0, checkIns: 0, races: 0, lastActive: null }

/** Registrations, check-ins and races per member in a window (both ends optional), from three grouped counts */
export async function activityByMember(window: { from?: Date; to?: Date } = {}, userIds?: string[]): Promise<Map<string, ActivityCounts>> {
  const range = window.from || window.to ? { ...(window.from ? { gte: window.from } : {}), ...(window.to ? { lte: window.to } : {}) } : undefined
  const who = userIds ? { userId: { in: userIds } } : {}
  const [registrations, checkIns, races] = await Promise.all([
    prisma.eventRegistration.groupBy({
      by: ["userId"],
      // Seats on events that happened or will; a cancelled event doesn't count
      where: { ...who, status: "REGISTERED", event: { status: { not: "CANCELLED" }, ...(range ? { startsAtUtc: range } : {}) } },
      _count: { _all: true },
      _max: { createdAt: true },
    }),
    prisma.eventAttendance.groupBy({
      by: ["userId"],
      where: { ...who, ...(range ? { checkedInAt: range } : {}) },
      _count: { _all: true },
      _max: { checkedInAt: true },
    }),
    prisma.raceParticipant.groupBy({
      by: ["userId"],
      where: { ...(userIds ? { userId: { in: userIds } } : { userId: { not: null } }), results: { some: {} }, session: { sessionType: "RACE", ...(range ? { startedAt: range } : {}) } },
      _count: { _all: true },
    }),
  ])
  const out = new Map<string, ActivityCounts>()
  const touch = (userId: string) => out.get(userId) ?? { ...NONE }
  const later = (a: Date | null, b: Date | null | undefined) => (b && (!a || b > a) ? b : a)
  for (const r of registrations) {
    const c = touch(r.userId)
    out.set(r.userId, { ...c, registrations: r._count._all, lastActive: later(c.lastActive, r._max.createdAt) })
  }
  for (const r of checkIns) {
    const c = touch(r.userId)
    out.set(r.userId, { ...c, checkIns: r._count._all, lastActive: later(c.lastActive, r._max.checkedInAt) })
  }
  for (const r of races) {
    if (!r.userId) continue
    const c = touch(r.userId)
    out.set(r.userId, { ...c, races: r._count._all })
  }
  return out
}

export type SortBy = "total" | "registrations" | "checkIns" | "races"

/** Members ordered by one count (ties by the total, then name); total is the three counts added up */
export function rankActivity<T extends ActivityCounts & { name: string }>(rows: T[], sortBy: SortBy): (T & { total: number })[] {
  return rows
    .map((row) => ({ ...row, total: row.registrations + row.checkIns + row.races }))
    .filter((row) => row.total > 0)
    .sort((a, b) => b[sortBy] - a[sortBy] || b.total - a.total || a.name.localeCompare(b.name))
}

const input = z.object({
  from: centralDateInput.optional().describe("First Central date counted (default: all time)"),
  to: centralDateInput.optional().describe("Last Central date counted (default: today)"),
  sortBy: z.enum(["total", "registrations", "checkIns", "races"]).default("total").describe("What to rank by; total adds the three counts"),
  limit: z.number().int().min(1).max(200).default(15).describe("How many members to list"),
})

export const memberActivityTool: JackTool<z.infer<typeof input>> = {
  name: "member_activity",
  description:
    "Ranks members by how active they are, counted three ways: event registrations (seats they held), check-ins at events, and races driven (race sessions with a result linked to their account; unlinked sim drivers aren't counted). Optional Central date range (default all time). Use it for 'most active member', 'who comes to the most events', 'who races the most'. Say which count you ranked by; check-ins are sparse because few events take them.",
  input,
  async run({ from, to, sortBy, limit }) {
    if (from && to && from > to) return { isError: true, forModel: `The range starts (${from}) after it ends (${to}).`, label: "Activity lookup failed", displays: [] }
    const counts = await activityByMember({ from: from ? startOfCentralDay(from) : undefined, to: to ? endOfCentralDay(to) : undefined })
    const users = await prisma.user.findMany({
      where: { id: { in: [...counts.keys()] }, status: { not: "deleted" } },
      select: { id: true, displayName: true, handle: true, email: true },
    })
    const ranked = rankActivity(
      users.map((u) => ({ name: u.displayName, handle: u.handle, email: u.email, ...(counts.get(u.id) ?? NONE) })),
      sortBy,
    )
    const rows = ranked.slice(0, limit).map((r) => ({
      name: r.name,
      handle: r.handle,
      email: r.email,
      registrations: r.registrations,
      checkIns: r.checkIns,
      races: r.races,
      total: r.total,
      lastRegisteredOrCheckedIn: ct(r.lastActive),
    }))
    const result = {
      window: { from: from ?? "the start", to: to ?? "no end (upcoming events' registrations count)", timeZone: "America/Chicago" },
      rankedBy: sortBy,
      definitions:
        "registrations = REGISTERED seats at events in the window (not cancelled ones); checkIns = event check-ins; races = race sessions with a result linked to the member; total = the three added up.",
      membersWithAnyActivity: ranked.length,
      members: rows,
    }
    return {
      forModel: forModelWithList(result, "members", rows),
      label: `Ranked members by ${sortBy === "checkIns" ? "check-ins" : sortBy} (${plural(ranked.length, "active member")})`,
      displays: rows.length
        ? [
            tableDisplay(
              rows,
              [
                { header: "Member", value: (r) => r.name },
                { header: "Registrations", value: (r) => r.registrations },
                { header: "Check-ins", value: (r) => r.checkIns },
                { header: "Races", value: (r) => r.races },
                { header: "Total", value: (r) => r.total },
              ],
              `Ranked by ${sortBy === "checkIns" ? "check-ins" : sortBy}${from || to ? `, ${from ?? "start"} to ${to ?? "today"}` : ", all time"}`,
            ),
          ]
        : [{ kind: "note", text: "No registrations, check-ins or races in that window." }],
    }
  },
}
