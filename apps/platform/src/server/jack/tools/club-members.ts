import { z } from "zod"
import { prisma } from "@/server/db"
import { forModel, plural, tableDisplay } from "./display"
import { addDays, centralDate, centralDateInput, ct, periodKey, periodsBetween, startOfCentralDay, endOfCentralDay, type Period } from "./time"
import type { JackTool } from "./types"

/**
 * club_members: how many members there are, who joined when, and how they break down by role and
 * membership tier (#161). Definitions match /admin/users: a deleted account isn't a member, and no
 * current membership row means a General member.
 */

const ROLE_KEYS = ["officer", "admin", "lsc_driver", "collegiate_driver"] as const

/** The first day of the month `months` before a date's month: monthsBefore("2026-10-13", 11) = "2025-11-01" */
export function monthsBefore(date: string, months: number): string {
  const [y, m] = date.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1 - months, 1)).toISOString().slice(0, 10)
}

/** Signups per period, with empty periods as zero */
export function bucketSignups(joined: Date[], from: string, to: string, by: Period) {
  const counts = new Map(periodsBetween(from, to, by).map((key) => [key, 0]))
  for (const date of joined) {
    const key = periodKey(date, by)
    if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return Array.from(counts, ([period, signups]) => ({ period, signups }))
}

/**
 * Current tier per member: their active membership rows, preferring a paid-style tier over GENERAL
 * when they have several; members with none are General.
 */
export function tierCounts(
  memberIds: string[],
  active: { userId: string; tier: { key: string; label: string } }[],
): { tier: string; label: string; members: number }[] {
  const byUser = new Map<string, { key: string; label: string }>()
  for (const row of active) {
    const current = byUser.get(row.userId)
    if (!current || current.key === "GENERAL") byUser.set(row.userId, row.tier)
  }
  const counts = new Map<string, { tier: string; label: string; members: number }>()
  for (const id of memberIds) {
    const tier = byUser.get(id) ?? { key: "GENERAL", label: "General Member" }
    const entry = counts.get(tier.key) ?? { tier: tier.key, label: tier.label, members: 0 }
    entry.members += 1
    counts.set(tier.key, entry)
  }
  return [...counts.values()].sort((a, b) => b.members - a.members)
}

const input = z.object({
  groupBy: z.enum(["week", "month"]).default("month").describe("Signup buckets: weeks start Monday; both in Central time"),
  from: centralDateInput.optional().describe("First Central date for signups (default: 12 months or 12 weeks back)"),
  to: centralDateInput.optional().describe("Last Central date for signups (default: today)"),
  newest: z.number().int().min(0).max(50).default(10).describe("How many of the newest members to list (0 for none)"),
})

export const clubMembersTool: JackTool<z.infer<typeof input>> = {
  name: "club_members",
  description:
    "Club membership numbers: accounts by status, signups over time (by week or month, Central time), counts by role (officer, admin, lsc_driver, collegiate_driver) and by membership tier (General, LSR Member, Alumni, Partner), active dues entitlements, and the newest members with emails. Use it for 'how many members', 'how many joined this month', 'who are the officers' counts.",
  input,
  async run({ groupBy, from, to, newest }) {
    const now = new Date()
    const today = centralDate(now)
    const end = to ?? today
    const start = from ?? (groupBy === "month" ? monthsBefore(end, 11) : addDays(end, -7 * 11))
    if (start > end) return { isError: true, forModel: `The range starts (${start}) after it ends (${end}).`, label: "Members lookup failed", displays: [] }

    const notDeleted = { status: { not: "deleted" as const } }
    const activeWindow = { validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gte: now } }] }

    const [byStatus, members, joined, roleRows, memberships, duesEntitlements, newestRows] = await Promise.all([
      prisma.user.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.user.findMany({ where: notDeleted, select: { id: true } }),
      prisma.user.findMany({
        where: { ...notDeleted, createdAt: { gte: startOfCentralDay(start), lte: endOfCentralDay(end) } },
        select: { createdAt: true },
      }),
      prisma.userRole.findMany({ where: { user: notDeleted }, select: { userId: true, role: { select: { key: true } } } }),
      prisma.userMembership.findMany({ where: { ...activeWindow, user: notDeleted }, select: { userId: true, tier: { select: { key: true, label: true } } } }),
      prisma.entitlement.findMany({ where: { kind: "lsr_member", ...activeWindow, user: notDeleted }, select: { sourcePaymentId: true } }),
      newest
        ? prisma.user.findMany({
            where: notDeleted,
            orderBy: { createdAt: "desc" },
            take: newest,
            select: { displayName: true, handle: true, email: true, eid: true, status: true, createdAt: true },
          })
        : Promise.resolve([]),
    ])

    const roles = Object.fromEntries(ROLE_KEYS.map((key) => [key, roleRows.filter((r) => r.role.key === key).length])) as Record<(typeof ROLE_KEYS)[number], number>
    const officers = new Set(roleRows.filter((r) => r.role.key === "officer" || r.role.key === "admin").map((r) => r.userId)).size
    const signups = bucketSignups(joined.map((u) => u.createdAt), start, end, groupBy)

    const result = {
      accounts: {
        members: members.length,
        byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
        note: "members = every account that isn't deleted",
      },
      roles: { ...roles, officersWithAdminAccess: officers },
      membershipTiers: tierCounts(
        members.map((m) => m.id),
        memberships,
      ),
      duesEntitlementsActive: {
        paid: duesEntitlements.filter((e) => e.sourcePaymentId).length,
        grantedByOfficer: duesEntitlements.filter((e) => !e.sourcePaymentId).length,
      },
      signups: { by: groupBy, from: start, to: end, total: joined.length, periods: signups },
      newest: newestRows.map((u) => ({ name: u.displayName, handle: u.handle, email: u.email, eid: u.eid, status: u.status, joined: ct(u.createdAt) })),
    }

    return {
      forModel: forModel(result),
      label: `Looked up members (${plural(members.length, "member")}, ${joined.length} joined since ${start})`,
      displays: [
        tableDisplay(signups, [
          { header: groupBy === "month" ? "Month" : "Week of", value: (r) => r.period },
          { header: "Signups", value: (r) => r.signups },
        ], `Signups by ${groupBy}, Central time`),
      ],
    }
  },
}
