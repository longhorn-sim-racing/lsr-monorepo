import { z } from "zod"
import type { JackToolDisplay } from "@/lib/jack/parts"
import { prisma } from "@/server/db"
import { departmentName } from "@/schemas/officer-profile.schema"
import { listSeasonEntrants } from "@/server/services/league-entry.service"
import { forModelWithLists, plural, tableDisplay, type ModelList } from "./display"
import { activityByMember } from "./member-activity"
import { DEFAULT_LEAGUE, resolveLeagueSeason } from "./seasons"
import { addDays, centralDate, centralDateInput, ct, dollars, periodKey, periodsBetween, startOfCentralDay, endOfCentralDay, type Period } from "./time"
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
  roster: z
    .enum(["none", "officers", "members"])
    .default("none")
    .describe(
      "officers: every officer and admin with their title, department, board seat, what they work on, major, grad year, roles, email and EID. members: every member (or those who joined between joinedFrom and joinedTo) with email, EID, join date, roles, events registered for, check-ins, races driven, this LSC season's entry status, and money paid",
    ),
  joinedFrom: centralDateInput.optional().describe("With roster members: only people whose account was made on or after this Central date"),
  joinedTo: centralDateInput.optional().describe("With roster members: only people whose account was made on or before this Central date"),
})

export const clubMembersTool: JackTool<z.infer<typeof input>> = {
  name: "club_members",
  description:
    "Club membership: accounts by status, signups over time (by week or month, Central time), counts by role (officer, admin, lsc_driver, collegiate_driver) and by membership tier (General, LSR Member, Alumni, Partner), active dues entitlements, and the newest members. roster lists people: 'officers' gives every officer and admin with title, department, board seat, what they work on, major, grad year, email and EID ('who are the officers', 'who works on sponsors'); 'members' gives every member (optionally only those who joined in a date range) with email, EID, join date, roles, events registered for, check-ins, races driven, LSC entry status for the open season, and dollars paid ('everyone's emails', 'people who joined in August and came back', a full member breakdown). Officers may see emails and EIDs.",
  input,
  async run({ groupBy, from, to, newest, roster, joinedFrom, joinedTo }) {
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
      signups: { by: groupBy, from: start, to: end, total: joined.length },
    }
    const newestList = newestRows.map((u) => ({ name: u.displayName, handle: u.handle, email: u.email, eid: u.eid, status: u.status, joined: ct(u.createdAt) }))
    const people = roster === "none" ? null : await buildRoster(roster, { joinedFrom, joinedTo, now })
    if (people && "error" in people) return { isError: true, forModel: people.error, label: "Members lookup failed", displays: [] }
    const forModelText = membersForModel(result, {
      roster: people ? { rows: people.rows, definitions: people.note, kind: roster as "officers" | "members" } : null,
      wholeClub: roster === "members" && !joinedFrom && !joinedTo,
      newest: newestList,
      signups,
    })

    return {
      // See membersForModel for how a roster and the newest members share the room
      forModel: forModelText,
      label: people
        ? `Listed ${roster === "officers" ? plural(people.rows.length, "officer") : plural(people.rows.length, "member")}`
        : `Looked up members (${plural(members.length, "member")}, ${joined.length} joined since ${start})`,
      displays: [
        ...(people ? [people.display] : []),
        tableDisplay(signups, [
          { header: groupBy === "month" ? "Month" : "Week of", value: (r) => r.period },
          { header: "Signups", value: (r) => r.signups },
        ], `Signups by ${groupBy}, Central time`),
      ],
    }
  },
}

/**
 * The model's JSON. A roster goes first and takes the room it needs. An unfiltered member roster that
 * fits whole already holds the newest members, so that list is left out then (and the result says
 * so); if the roster had to be cut short, its newest rows are the ones cut, so the newest list goes
 * first instead.
 */
export function membersForModel(
  result: Record<string, unknown>,
  opts: { roster: { rows: unknown[]; definitions: string; kind: "officers" | "members" } | null; wholeClub: boolean; newest: unknown[]; signups: unknown[] },
): string {
  const rosterList: ModelList[] = opts.roster
    ? [
        {
          key: "roster",
          items: opts.roster.rows,
          ...(opts.roster.kind === "members" ? { whenTrimmed: "Ask again with joinedFrom and joinedTo to get the rest, a few months at a time." } : {}),
        },
      ]
    : []
  const newest: ModelList = { key: "newest", items: opts.newest }
  const periods: ModelList = { key: "signupPeriods", items: opts.signups, keep: "last" }
  const base = opts.roster ? { ...result, rosterDefinitions: opts.roster.definitions } : result
  if (!opts.roster || !opts.wholeClub) return forModelWithLists(base, [...rosterList, newest, periods])
  const whole = forModelWithLists({ ...base, newest: "left out: the roster has everyone, oldest first" }, [...rosterList, periods])
  return (JSON.parse(whole) as Record<string, unknown>).rosterNote ? forModelWithLists(base, [newest, ...rosterList, periods]) : whole
}

/** Officers and admins with titles, or every member (optionally by join date) with what they've done */
type Roster = { rows: Record<string, unknown>[]; note: string; display: JackToolDisplay }

/** Said with every roster: the room has the table, the reply has the point */
const SUMMARIZE = "The room shows the whole list as a table, so don't repeat its rows in your reply: summarize, and name people when asked which people or who (up to about 20)."

/** A roster row without its empty fields: null, an empty list, zero */
export function compactRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== undefined && v !== 0 && !(Array.isArray(v) && v.length === 0)))
}

async function buildRoster(
  kind: "officers" | "members",
  { joinedFrom, joinedTo, now }: { joinedFrom?: string; joinedTo?: string; now: Date },
): Promise<Roster | { error: string }> {
  if (kind === "officers") {
    const officers = await prisma.user.findMany({
      where: { status: { not: "deleted" }, roles: { some: { role: { key: { in: ["officer", "admin"] } } } } },
      orderBy: { displayName: "asc" },
      select: {
        displayName: true,
        handle: true,
        officerTitle: true,
        department: true,
        isBoard: true,
        workingOn: true,
        major: true,
        gradYear: true,
        email: true,
        eid: true,
        roles: { select: { role: { select: { key: true } } } },
      },
    })
    const rows = officers.map((u) => ({
      name: u.displayName,
      handle: u.handle,
      title: u.officerTitle,
      department: departmentName(u.department),
      board: u.isBoard || null,
      workingOn: u.workingOn,
      major: u.major,
      gradYear: u.gradYear,
      roles: u.roles.map((r) => r.role.key),
      email: u.email,
      eid: u.eid,
    }))
    return {
      // The model's copy leaves out empty fields, like the member roster
      rows: rows.map(compactRow),
      note:
        `Everyone with the officer or admin role (both open the admin console). title is the board title shown on the site; department is their team (as on the About page) and board: true means they hold a board seat; ` +
        `workingOn is what they say they work on, in their own words, and major and gradYear are from their profile. A field that's left out is empty. ${SUMMARIZE}`,
      display: tableDisplay(rows, [
        { header: "Officer", value: (r) => r.name },
        { header: "Title", value: (r) => r.title },
        { header: "Department", value: (r) => (r.board ? `${r.department ?? "No department"} · board` : r.department) },
        { header: "Works on", value: (r) => r.workingOn },
        { header: "Roles", value: (r) => r.roles.join(", ") },
        { header: "Email", value: (r) => r.email },
      ], `${plural(rows.length, "officer")} and admins`),
    }
  }

  if (joinedFrom && joinedTo && joinedFrom > joinedTo) return { error: `joinedFrom (${joinedFrom}) is after joinedTo (${joinedTo}).` }
  const users = await prisma.user.findMany({
    where: {
      status: { not: "deleted" },
      ...(joinedFrom || joinedTo
        ? { createdAt: { ...(joinedFrom ? { gte: startOfCentralDay(joinedFrom) } : {}), ...(joinedTo ? { lte: endOfCentralDay(joinedTo) } : {}) } }
        : {}),
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, displayName: true, handle: true, email: true, eid: true, createdAt: true, roles: { select: { role: { select: { key: true } } } } },
  })
  const ids = users.map((u) => u.id)
  const season = await resolveLeagueSeason(DEFAULT_LEAGUE, undefined, now)
  const [activity, paid, entrants] = await Promise.all([
    activityByMember({}, ids),
    prisma.payment.groupBy({ by: ["userId"], where: { userId: { in: ids }, status: "succeeded" }, _sum: { amountCents: true } }),
    season.ok ? listSeasonEntrants(season.season.id) : Promise.resolve(null),
  ])
  const paidBy = new Map(paid.map((p) => [p.userId, p._sum.amountCents ?? 0]))
  const lscBy = new Map((entrants?.entrants ?? []).map((e) => [e.user.id, e.status === "none" ? "form only" : e.status]))
  const rows = users.map((u) => {
    const a = activity.get(u.id)
    return {
      name: u.displayName,
      email: u.email,
      eid: u.eid,
      joined: centralDate(u.createdAt),
      roles: u.roles.map((r) => r.role.key),
      eventsRegistered: a?.registrations ?? 0,
      checkIns: a?.checkIns ?? 0,
      racesDriven: a?.races ?? 0,
      lsc: lscBy.get(u.id) ?? null,
      paidDollars: dollars(paidBy.get(u.id) ?? 0),
    }
  })
  return {
    // The model's copy leaves out empty fields (no EID, no roles, zero counts), so a whole club fits
    rows: rows.map(compactRow),
    note:
      `Every member${joinedFrom || joinedTo ? ` who joined ${joinedFrom ?? "any time"} to ${joinedTo ?? "now"} (Central)` : ""}, oldest account first. ` +
      `A field that's left out is empty or zero. joined = Central date the account was made; eventsRegistered = REGISTERED seats on events that weren't cancelled (all time); checkIns = event check-ins; racesDriven = race sessions with a linked result; ` +
      `lsc = entry status for ${season.ok ? season.season.name : "the open LSC season"} (paid, manual, ended, form only; left out = no form); paidDollars = succeeded payments, all time. ${SUMMARIZE}`,
    display: tableDisplay(rows, [
      { header: "Member", value: (r) => r.name },
      { header: "Email", value: (r) => r.email },
      { header: "EID", value: (r) => r.eid },
      { header: "Joined", value: (r) => r.joined },
      { header: "Events", value: (r) => r.eventsRegistered },
      { header: "Races", value: (r) => r.racesDriven },
      { header: "LSC", value: (r) => r.lsc },
      { header: "Paid", value: (r) => `$${r.paidDollars.toFixed(2)}` },
    ], plural(rows.length, "member")),
  }
}
