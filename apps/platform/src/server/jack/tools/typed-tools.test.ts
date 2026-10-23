import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

// Only the pure shaping logic is tested here; nothing touches a database
vi.mock("@/server/db", () => ({ prisma: {} }))
vi.mock("@/server/jack/sql-client", () => ({ getJackSqlClient: () => null, JACK_SQL_MISSING: "missing" }))

import type { SeasonEntrant } from "@/server/services/league-entry.service"
import { auditWhere } from "./audit-log"
import { bucketSignups, compactRow, membersForModel, monthsBefore, tierCounts } from "./club-members"
import { forModelWithList, forModelWithLists, MAX_MODEL_CHARS } from "./display"
import { formatSchema, parseConstraints, typeName } from "./describe-schema"
import { summarizeEvent, searchWhere, type EventRow } from "./events-overview"
import { CORE_JACK_TOOLS, JACK_TOOLS, findJackTool } from "./index"
import { SLOT_TOOLS } from "./registry"
import { checkoutOutcome, driverRow, entrantSummary, schoolOf } from "./lsc-entries"
import { rankActivity } from "./member-activity"
import { itemName, purchaseKey, summarizePayments, unpaidCheckouts, type PaymentRow } from "./payments-summary"
import { raceSessionsCount, roundResults } from "./standings"
import { addDays, centralDateInput, centralRange, ct, endOfCentralDay, isCalendarDate, periodKey, periodsBetween, startOfCentralDay, weekStart } from "./time"

describe("Central time helpers", () => {
  it("formats instants in Central time, across daylight saving", () => {
    // With the weekday, so no model has to work one out
    expect(ct(new Date("2026-10-19T23:00:00Z"))).toBe("Mon 2026-10-19 18:00 CT") // CDT
    expect(ct(new Date("2026-12-01T00:30:00Z"))).toBe("Mon 2026-11-30 18:30 CT") // CST
    expect(ct(null)).toBeNull()
  })

  it("turns Central dates into UTC day bounds", () => {
    expect(startOfCentralDay("2026-10-19").toISOString()).toBe("2026-10-19T05:00:00.000Z")
    expect(endOfCentralDay("2026-10-19").toISOString()).toBe("2026-10-20T04:59:59.999Z")
    expect(startOfCentralDay("2026-12-01").toISOString()).toBe("2026-12-01T06:00:00.000Z")
  })

  it("buckets by Central day, Monday-start week and month", () => {
    // 11:30 PM Sunday Oct 18 in Central is already Monday in UTC
    const lateSunday = new Date("2026-10-19T04:30:00Z")
    expect(periodKey(lateSunday, "day")).toBe("2026-10-18")
    expect(periodKey(lateSunday, "week")).toBe("2026-10-12")
    expect(periodKey(new Date("2026-11-01T03:00:00Z"), "month")).toBe("2026-10")
    expect(weekStart("2026-10-19")).toBe("2026-10-19")
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01")
  })

  it("lists every period in a range, across a year boundary", () => {
    expect(periodsBetween("2025-11-15", "2026-02-01", "month")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"])
    expect(periodsBetween("2026-10-14", "2026-10-27", "week")).toEqual(["2026-10-12", "2026-10-19", "2026-10-26"])
  })

  it("defaults ranges relative to today and rejects a backwards one", () => {
    const now = new Date("2026-10-13T15:00:00Z")
    expect(centralRange({}, { fromDaysAgo: 7, toDaysAhead: 0 }, now)).toMatchObject({ ok: true, from: "2026-10-06", to: "2026-10-13" })
    expect(centralRange({ from: "2026-10-20", to: "2026-10-01" }, { fromDaysAgo: 0, toDaysAhead: 0 }, now)).toEqual({ ok: false, error: expect.stringContaining("after it ends") })
  })
})

describe("club_members shaping", () => {
  it("counts signups per period, with empty periods as zero", () => {
    const joined = [new Date("2026-09-30T15:00:00Z"), new Date("2026-10-01T04:00:00Z"), new Date("2026-10-12T15:00:00Z")]
    // Oct 1 04:00 UTC is still Sep 30 in Central
    expect(bucketSignups(joined, "2026-08-01", "2026-10-13", "month")).toEqual([
      { period: "2026-08", signups: 0 },
      { period: "2026-09", signups: 2 },
      { period: "2026-10", signups: 1 },
    ])
  })

  it("counts members with no current membership as General, and prefers a real tier over GENERAL", () => {
    const tiers = tierCounts(
      ["a", "b", "c", "d"],
      [
        { userId: "a", tier: { key: "LSR_MEMBER", label: "LSR Member" } },
        { userId: "b", tier: { key: "GENERAL", label: "General Member" } },
        { userId: "b", tier: { key: "ALUMNI", label: "Alumni" } },
      ],
    )
    expect(tiers).toEqual([
      { tier: "GENERAL", label: "General Member", members: 2 },
      { tier: "LSR_MEMBER", label: "LSR Member", members: 1 },
      { tier: "ALUMNI", label: "Alumni", members: 1 },
    ])
  })

  it("goes back whole months", () => {
    expect(monthsBefore("2026-10-13", 11)).toBe("2025-11-01")
    expect(monthsBefore("2026-03-31", 1)).toBe("2026-02-01")
  })
})

describe("events_overview shaping", () => {
  const event = (overrides: Partial<EventRow> = {}): EventRow => ({
    id: "e1",
    title: "General Meeting 1",
    slug: "general-meeting-1",
    status: "PUBLISHED",
    visibility: "public",
    publishedAt: new Date("2026-09-01T00:00:00Z"),
    startsAtUtc: new Date("2026-10-05T23:00:00Z"),
    endsAtUtc: new Date("2026-10-06T01:00:00Z"),
    registrationEnabled: true,
    registrationMax: 50,
    registrationWaitlistEnabled: true,
    registrationFeeCents: null,
    attendanceEnabled: false,
    attendanceReportingMode: "ASSUME_REGISTERED",
    series: null,
    venue: { name: "GDC 2.216" },
    _count: { rawResultUploads: 0, ingestedSessions: 0 },
    ...overrides,
  })
  const now = new Date("2026-10-13T12:00:00Z")

  it("counts everyone registered as attended when the event doesn't take check-ins", () => {
    const row = summarizeEvent(event(), { REGISTERED: 30, WAITLISTED: 4, NOT_ATTENDING: 2 }, now)
    expect(row).toMatchObject({
      startsAt: "Mon 2026-10-05 18:00 CT",
      status: "PUBLISHED",
      effectiveStatus: "COMPLETED",
      public: true,
      // Settings, said plainly: the event took sign-ups even though it's over
      takesRegistrations: true,
      takesCheckIns: false,
      registration: { registered: 30, waitlisted: 4, notAttending: 2, capacity: 50, filled: "30/50" },
      attendance: { basis: "assumed: everyone registered", attended: 30, checkedIn: 0 },
      manageLink: expect.stringMatching(/^https?:\/\/[^/]+\/admin\/events\/e1\/manage$/),
    })
  })

  it("counts check-ins when the event takes them, and nothing before it starts", () => {
    const past = summarizeEvent(event({ attendanceEnabled: true, attendanceReportingMode: "CHECKIN_REQUIRED" }), { REGISTERED: 30, checkedIn: 22 }, now)
    expect(past.attendance).toEqual({ basis: "check-ins", attended: 22, checkedIn: 22 })
    const upcoming = summarizeEvent(event({ startsAtUtc: new Date("2026-12-01T00:00:00Z"), endsAtUtc: new Date("2026-12-01T02:00:00Z") }), { REGISTERED: 5 }, now)
    expect(upcoming.attendance.attended).toBeNull()
  })

  it("shows drafts as hidden, and fees and results", () => {
    const row = summarizeEvent(event({ status: "DRAFT", registrationFeeCents: 1250, _count: { rawResultUploads: 1, ingestedSessions: 0 } }), {}, now)
    expect(row).toMatchObject({ effectiveStatus: "DRAFT", public: false, registration: { feeDollars: 12.5 }, results: "uploaded, no race results yet" })
    // A past round of a league's race series with nothing uploaded says so; a general meeting or a one-off says nothing
    expect(summarizeEvent(event({ series: { title: "LSC S3", _count: { seasons: 1 } } }), {}, now).results).toBe("none uploaded")
    expect(summarizeEvent(event({ series: { title: "General Meetings", _count: { seasons: 0 } } }), {}, now).results).toBeNull()
    expect(summarizeEvent(event(), {}, now).results).toBeNull()
  })

  it("matches every search word in the title, slug or series", () => {
    expect(searchWhere(undefined)).toEqual({})
    const where = searchWhere("general  meeting") as { AND: unknown[] }
    expect(where.AND).toHaveLength(2)
    expect(JSON.stringify(where.AND[0])).toContain('"contains":"general"')
  })
})

describe("lsc_entries shaping", () => {
  const entrant = (
    status: SeasonEntrant["status"],
    extra: { source?: "SITE" | "ADMIN" | "GOOGLE_FORM" | null; cents?: number; tier?: string; formAt?: string; school?: string; experience?: string; notes?: string } = {},
  ) =>
    ({
      status,
      user: { id: status, handle: status, displayName: `Driver ${status}`, email: `${status}@utexas.edu`, eid: "abc123" },
      application:
        extra.source === null
          ? null
          : {
              source: extra.source ?? "SITE",
              createdAt: new Date(extra.formAt ?? "2026-10-01T15:00:00Z"),
              discordUsername: "d",
              school: extra.school ?? null,
              experience: extra.experience ?? "CASUAL",
              equipment: ["WHEEL_PEDALS"],
              canCommit: true,
              notes: extra.notes ?? null,
            },
      entry:
        status === "none"
          ? null
          : {
              meta: status === "manual" ? { source: "manual", note: "Paid cash" } : { seasonSlug: "lone-star-cup-s3" },
              validFrom: new Date("2026-10-02T15:00:00Z"),
              payment: extra.cents ? { amountCents: extra.cents, paidAt: new Date("2026-10-02T15:00:00Z"), metadata: { priceTier: extra.tier ?? "standard" } } : null,
            },
    }) as unknown as SeasonEntrant

  it("counts forms, entries and money the way /admin/league-entries does", () => {
    const entrants = [
      entrant("paid", { cents: 1000 }),
      entrant("paid", { cents: 500, tier: "returning", source: "GOOGLE_FORM", school: "Texas A&M", experience: "COMPETITIVE" }),
      entrant("manual", { source: "ADMIN" }),
      entrant("ended", { formAt: "2026-09-20T15:00:00Z" }),
      entrant("none"),
      entrant("manual", { source: null }),
    ]
    expect(entrantSummary(entrants, new Date("2026-09-29T05:00:00Z"))).toEqual({
      // A blank school on the form means UT Austin
      forms: {
        total: 5,
        bySource: { SITE: 3, GOOGLE_FORM: 1, ADMIN: 1 },
        bySchool: { "UT Austin": 4, "Texas A&M": 1 },
        byExperience: { CASUAL: 4, COMPETITIVE: 1 },
        newSince: 4,
      },
      entries: { entered: 4, paid: 2, manual: 2, ended: 1, formButNotEntered: 2 },
      paidIn: { dollars: 15, returningRate: 1 },
    })
  })

  it("lists a driver with contact details, status and payment in Central time", () => {
    expect(driverRow(entrant("paid", { cents: 500, tier: "returning" }))).toMatchObject({
      email: "paid@utexas.edu",
      eid: "abc123",
      status: "paid",
      paidDollars: 5,
      paidAt: "Fri 2026-10-02 10:00 CT",
      returningRate: true,
      school: "UT Austin",
      experience: "CASUAL",
    })
    expect(driverRow(entrant("manual"))).toMatchObject({ paidDollars: null, paidAt: "Fri 2026-10-02 10:00 CT", note: "Paid cash" })
    // The driver's own words, cut to a few hundred characters
    const long = driverRow(entrant("none", { notes: "x".repeat(400), school: "Clemson" }))
    expect(long).toMatchObject({ school: "Clemson" })
    expect(long.formNotes).toHaveLength(301)
    expect(driverRow(entrant("manual", { source: null }))).toMatchObject({ school: null, formNotes: null })
  })

  it("names what happened to an unpaid checkout", () => {
    expect(checkoutOutcome("pending", undefined)).toContain("not finished")
    expect(checkoutOutcome("failed", "PAYMENT_EXPIRED")).toBe("expired")
    expect(checkoutOutcome("failed", "PAYMENT_FAILED")).toBe("payment failed")
    expect(checkoutOutcome("failed", undefined)).toBe("failed or expired")
  })
})

describe("payments_summary shaping", () => {
  const payment = (overrides: Partial<PaymentRow>): PaymentRow => ({
    id: "p",
    status: "succeeded",
    amountCents: 1000,
    createdAt: new Date("2026-10-02T15:00:00Z"),
    paidAt: new Date("2026-10-02T15:05:00Z"),
    productId: "lsc",
    providerRef: "cs_1",
    metadata: null,
    product: { name: "Lone Star Cup Entry Fee", type: "LEAGUE_FEE" },
    eventRegistration: null,
    user: { displayName: "Driver", email: "d@utexas.edu" },
    ...overrides,
  })

  it("totals by status and item in dollars, and flags duplicates", () => {
    const summary = summarizePayments([
      payment({}),
      payment({ amountCents: 500 }),
      payment({ status: "failed", paidAt: null }),
      payment({ metadata: { duplicateOfEntitlementId: "ent-1" } }),
      payment({ productId: null, product: null, eventRegistration: { event: { title: "Karting Night" } }, amountCents: 1500 }),
    ])
    expect(summary.totals.succeeded).toEqual({ count: 4, dollars: 40 })
    expect(summary.totals.failed).toEqual({ count: 1, dollars: 10 })
    expect(summary.collectedDollars).toBe(40)
    expect(summary.byItem).toEqual([
      { item: "Event fee: Karting Night", kind: "Event fee", status: "succeeded", count: 1, dollars: 15 },
      { item: "Lone Star Cup Entry Fee", kind: "League entry", status: "failed", count: 1, dollars: 10 },
      { item: "Lone Star Cup Entry Fee", kind: "League entry", status: "succeeded", count: 3, dollars: 25 },
    ])
    expect(summary.flaggedDuplicates).toEqual([{ name: "Driver", email: "d@utexas.edu", item: "Lone Star Cup Entry Fee", dollars: 10, paidAt: "Fri 2026-10-02 10:05 CT" }])
  })

  it("names productless payments as event fees", () => {
    expect(itemName({ product: null, eventRegistration: null })).toBe("Event fee")
    expect(itemName({ product: null, eventRegistration: null }, "GM 2")).toBe("Event fee: GM 2")
    expect(itemName({ product: null, eventRegistration: { event: { title: "Karting Night" } } }, "GM 2")).toBe("Event fee: Karting Night")
  })
})

describe("standings shaping", () => {
  const now = new Date("2026-10-13T12:00:00Z")
  const round = (date: string, uploads: number, sessions: number) => ({ startsAtUtc: new Date(date), _count: { rawResultUploads: uploads, ingestedSessions: sessions } })
  it("says which rounds have results", () => {
    expect(roundResults(round("2026-10-03T15:00:00Z", 1, 3), now)).toBe("results in")
    expect(roundResults(round("2026-10-10T15:00:00Z", 1, 0), now)).toBe("uploaded, no race results")
    expect(roundResults(round("2026-10-10T15:00:00Z", 0, 0), now)).toBe("no results yet")
    expect(roundResults(round("2026-10-17T15:00:00Z", 0, 0), now)).toBe("upcoming")
  })
})

describe("audit_log filters", () => {
  const range = { start: new Date("2026-10-06T05:00:00Z"), end: new Date("2026-10-14T04:59:59Z") }
  it("matches action and entity case-insensitively, and 'system' as no actor", () => {
    expect(auditWhere({ ...range, action: "payment_succeeded", actor: "system" })).toEqual({
      createdAt: { gte: range.start, lte: range.end },
      NOT: expect.anything(),
      actionType: { equals: "payment_succeeded", mode: "insensitive" },
      actorUserId: null,
    })
    const byName = auditWhere({ ...range, actor: "alex", search: "standings" })
    expect(byName).toMatchObject({ summary: { contains: "standings", mode: "insensitive" }, actor: { OR: expect.any(Array) } })
  })

  it("never shows recruiting entries about an officer's or admin's own application", () => {
    expect(auditWhere(range).NOT).toEqual({
      entityType: { in: ["APPLICATION", "APPLICATION_TRACK", "APPLICATION_EMAIL"] },
      targetUser: { roles: { some: { role: { key: { in: ["officer", "admin"] } } } } },
    })
    // Filtering by entity doesn't lift it
    expect(auditWhere({ ...range, entity: "APPLICATION_TRACK" }).NOT).toBeDefined()
  })
})

describe("describe_schema formatting", () => {
  const columns = [
    { t: "Event", c: "id", dt: "text", udt: "text", nullable: false },
    { t: "Event", c: "venueId", dt: "text", udt: "text", nullable: true },
    { t: "Event", c: "status", dt: "USER-DEFINED", udt: "EventStatus", nullable: false },
    { t: "Event", c: "startsAtUtc", dt: "timestamp without time zone", udt: "timestamp", nullable: false },
    { t: "LeagueApplication", c: "equipment", dt: "ARRAY", udt: "_RacingEquipment", nullable: false },
    { t: "Venue", c: "id", dt: "text", udt: "text", nullable: false },
  ]
  const constraints = [
    { t: "Event", kind: "p", def: "PRIMARY KEY (id)" },
    { t: "Event", kind: "f", def: 'FOREIGN KEY ("venueId") REFERENCES "Venue"(id) ON UPDATE CASCADE ON DELETE SET NULL' },
    { t: "Venue", kind: "p", def: "PRIMARY KEY (id)" },
  ]
  const enums = [
    { name: "EventStatus", labels: "DRAFT|PUBLISHED" },
    { name: "RacingEquipment", labels: "WHEEL|PEDALS" },
    { name: "Unused", labels: "A|B" },
  ]

  it("names types the way the model writes them", () => {
    expect(typeName({ dt: "USER-DEFINED", udt: "EventStatus" })).toBe("EventStatus")
    expect(typeName({ dt: "ARRAY", udt: "_RacingEquipment" })).toBe("RacingEquipment[]")
    expect(typeName({ dt: "timestamp without time zone", udt: "timestamp" })).toBe("timestamp")
    expect(typeName({ dt: "integer", udt: "int4" })).toBe("int")
  })

  it("reads keys from constraint definitions", () => {
    const { primary, foreign } = parseConstraints(constraints)
    expect(primary.get("Event")).toEqual(new Set(["id"]))
    expect(foreign.get("Event")?.get("venueId")).toBe("Venue")
  })

  it("lists tables with keys, used enums and the notes", () => {
    const { text, tables } = formatSchema(columns, constraints, enums)
    expect(tables).toEqual(["Event", "LeagueApplication", "Venue"])
    expect(text).toContain("id text pk, venueId text? -> Venue, status EventStatus, startsAtUtc timestamp")
    expect(text).toContain("equipment RacingEquipment[]")
    expect(text).toContain("EventStatus: DRAFT|PUBLISHED")
    expect(text).not.toContain("Unused")
    expect(text).toContain("How the club's data fits together")
  })

  it("filters to the tables asked for and says which weren't found", () => {
    const { text, tables, missing } = formatSchema(columns, constraints, enums, { tables: ['"event"', "SystemSetting"] })
    expect(tables).toEqual(["Event"])
    expect(missing).toEqual(["SystemSetting"])
    expect(text).toContain("Not found, or not readable by Jack: SystemSetting")
    expect(text).not.toContain("How the club's data fits together")
  })

  it("adds the tracks' notes after the core notes, only for the full schema, and their table notes beside the columns", () => {
    const trackNotes = ["Discord\n- DiscordMessage keeps no message text."]
    const full = formatSchema(columns, constraints, enums, { tableNotes: { Venue: "Where an event happens." }, trackNotes }).text
    expect(full).toContain('"Venue" (Where an event happens.)')
    expect(full.indexOf("DiscordMessage keeps no message text")).toBeGreaterThan(full.indexOf("How the club's data fits together"))
    const some = formatSchema(columns, constraints, enums, { tables: ["Venue"], tableNotes: { Venue: "Where an event happens." }, trackNotes }).text
    expect(some).toContain('"Venue" (Where an event happens.)')
    expect(some).not.toContain("DiscordMessage")
  })
})

describe("forModelWithList", () => {
  it("keeps the whole list when it fits, and trims it with a note when it doesn't", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: i, title: "x".repeat(40) }))
    expect(JSON.parse(forModelWithList({ count: 50 }, "events", items)).events).toHaveLength(50)
    const trimmed = forModelWithList({ count: 50 }, "events", items, 1_000)
    const body = JSON.parse(trimmed)
    expect(trimmed.length).toBeLessThanOrEqual(1_000)
    expect(body.count).toBe(50)
    expect(body.events.length).toBeLessThan(50)
    expect(body.eventsNote).toBe(`Only the first ${body.events.length} of 50 events fit in this reply. Narrow the request to see the rest.`)
  })
})

describe("forModelWithLists", () => {
  it("fits several lists under the cap, earlier lists first, keeping the newest end of a 'last' list", () => {
    const newest = Array.from({ length: 50 }, (_, i) => ({ name: `Member ${i}`, email: `m${i}@example.com`, joined: "2026-10-01 18:00 CT" }))
    const periods = periodsBetween("2016-01-04", "2026-10-12", "week").map((period) => ({ period, signups: 1 }))
    const text = forModelWithLists({ accounts: { members: 500 }, newest: "ignored", signupPeriods: "ignored" }, [
      { key: "newest", items: newest },
      { key: "signupPeriods", items: periods, keep: "last" },
    ])
    const body = JSON.parse(text)

    expect(text.length).toBeLessThanOrEqual(MAX_MODEL_CHARS)
    expect(body.accounts).toEqual({ members: 500 })
    expect(body.newest).toHaveLength(50)
    expect(body.newestNote).toBeUndefined()
    expect(body.signupPeriods.length).toBeGreaterThan(0)
    expect(body.signupPeriods.length).toBeLessThan(periods.length)
    expect(body.signupPeriods.at(-1)).toEqual(periods.at(-1)) // the latest weeks stay
    expect(body.signupPeriodsNote).toBe(`Only the last ${body.signupPeriods.length} of ${periods.length} signupPeriods fit in this reply. Narrow the request to see the rest.`)
  })

  it("leaves short lists whole, in order", () => {
    const body = JSON.parse(forModelWithLists({ total: 2 }, [{ key: "a", items: [1, 2] }, { key: "b", items: [3], keep: "last" }]))
    expect(body).toEqual({ total: 2, a: [1, 2], b: [3] })
  })
})

describe("centralDateInput", () => {
  it("takes real calendar dates only, with a message the model can act on", () => {
    expect(isCalendarDate("2026-10-19")).toBe(true)
    expect(isCalendarDate("2028-02-29")).toBe(true) // leap year
    for (const bad of ["2026-02-30", "2026-02-29", "2026-04-31", "2026-13-01", "2026-00-10", "2026-10-00"]) expect(isCalendarDate(bad), bad).toBe(false)

    const parsed = centralDateInput.safeParse("2026-02-30")
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0].message).toBe("2026-02-30 isn't a date on the calendar; check the month's last day")
    expect(centralDateInput.safeParse("Oct 19").error?.issues[0].message).toBe("Use a date like 2026-10-19")
  })
})

describe("raceSessionsCount", () => {
  it("counts only race sessions with results, as Recompute standings does", () => {
    expect(raceSessionsCount).toEqual({ where: { sessionType: "RACE", results: { some: {} } } })
  })
})

describe("the tool list", () => {
  it("starts with today's 21 tools, unchanged in name and order (the order is part of the cached prompt)", () => {
    const names = JACK_TOOLS.slice(0, 21).map((t) => t.name)
    expect(CORE_JACK_TOOLS.map((t) => t.name)).toEqual(names)
    expect(names).toEqual([
      "club_members",
      "member_activity",
      "events_overview",
      "lsc_entries",
      "payments_summary",
      "standings",
      "audit_log",
      "describe_schema",
      "run_sql",
      "chart",
      "draft_event",
      "deck_guide",
      "deck_assets",
      "deck_create",
      "deck_write",
      "deck_edit",
      "deck_arrange",
      "deck_view",
      "deck_render",
      "deck_restore",
      "deck_screenshot",
    ])
  })

  it("follows them with the tracks' slot tools, and every name is unique snake_case", () => {
    expect(JACK_TOOLS.slice(CORE_JACK_TOOLS.length)).toEqual(SLOT_TOOLS)
    const names = JACK_TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name).toMatch(/^[a-z][a-z_]*$/)
    expect(findJackTool("run_sql")?.name).toBe("run_sql")
    expect(findJackTool("nope")).toBeUndefined()
  })

  it("marks only draft_event and the deck changes as writing among today's tools; only draft_event touches club data", () => {
    expect(CORE_JACK_TOOLS.filter((t) => t.writes).map((t) => t.name)).toEqual(["draft_event", "deck_create", "deck_write", "deck_edit", "deck_arrange", "deck_restore"])
    expect(CORE_JACK_TOOLS.filter((t) => t.design).map((t) => t.name)).toEqual(CORE_JACK_TOOLS.filter((t) => t.name.startsWith("deck_")).map((t) => t.name))
    expect(CORE_JACK_TOOLS.some((t) => t.deferred)).toBe(false)
  })

  it("gives every tool an input the model loop can send as JSON Schema, and defaults that parse from {}", () => {
    for (const tool of JACK_TOOLS) {
      const schema = z.toJSONSchema(tool.input) as { type?: string }
      expect(schema.type, tool.name).toBe("object")
      expect(tool.description.length, tool.name).toBeGreaterThan(80)
    }
    for (const name of ["club_members", "member_activity", "events_overview", "lsc_entries", "payments_summary", "standings", "audit_log", "describe_schema"]) {
      expect(findJackTool(name)!.input.safeParse({}).success, name).toBe(true)
    }
  })
})

describe("unpaid checkouts", () => {
  const attempt = (userId: string, status: "pending" | "failed" | "succeeded", productId: string | null, at: string, eventId?: string) => ({
    userId,
    status,
    productId,
    metadata: eventId ? { eventId } : null,
    createdAt: new Date(at),
    amountCents: 1000,
  })

  it("names what was bought: the product, or the event for an event fee", () => {
    expect(purchaseKey({ productId: "lsc", metadata: null })).toBe("product:lsc")
    expect(purchaseKey({ productId: null, metadata: { eventId: "e1" } })).toBe("event:e1")
    expect(purchaseKey({ productId: null, metadata: null, eventRegistration: { eventId: "e2" } })).toBe("event:e2")
  })

  it("keeps people who never paid for the item, once each with their latest try", () => {
    const attempts = [
      attempt("anya", "pending", "lsc", "2026-10-01T15:00:00Z"),
      attempt("anya", "failed", "lsc", "2026-10-03T15:00:00Z"),
      attempt("sam", "failed", "lsc", "2026-10-09T15:00:00Z"),
      // Gray tried, then paid for the same thing: not unpaid
      attempt("gray", "failed", "lsc", "2026-09-30T15:00:00Z"),
      // Sam paid for a different event, which doesn't clear the LSC checkout
      attempt("sam", "pending", null, "2026-10-02T15:00:00Z", "karting"),
    ]
    const succeeded = [
      { userId: "gray", productId: "lsc", metadata: null },
      { userId: "sam", productId: null, metadata: { eventId: "karting" } },
    ]
    expect(unpaidCheckouts(attempts, succeeded).map((a) => `${a.userId} ${a.createdAt.toISOString().slice(5, 10)}`)).toEqual(["sam 10-09", "anya 10-03"])
  })
})

describe("member_activity ranking", () => {
  const member = (name: string, registrations: number, checkIns: number, races: number) => ({ name, registrations, checkIns, races, lastActive: null })

  it("ranks by the chosen count, ties by the total then name, and leaves out the inactive", () => {
    const rows = [member("Harold", 0, 0, 54), member("Mark", 1, 0, 52), member("Douglas", 3, 1, 0), member("Quiet", 0, 0, 0)]
    expect(rankActivity(rows, "races").map((r) => r.name)).toEqual(["Harold", "Mark", "Douglas"])
    expect(rankActivity(rows, "registrations").map((r) => r.name)).toEqual(["Douglas", "Mark", "Harold"])
    expect(rankActivity(rows, "total")[0]).toMatchObject({ name: "Harold", total: 54 })
  })
})

describe("an entry form's school", () => {
  it("reads a blank school as UT Austin, and no form as no school", () => {
    expect(schoolOf({ school: null })).toBe("UT Austin")
    expect(schoolOf({ school: "  " })).toBe("UT Austin")
    expect(schoolOf({ school: "Clemson" })).toBe("Clemson")
    expect(schoolOf(null)).toBeNull()
  })
})

describe("club_members roster", () => {
  it("leaves empty fields out of the model's copy", () => {
    expect(compactRow({ name: "Ana", eid: null, roles: [], checkIns: 0, races: 3, lsc: null, paidDollars: 0 })).toEqual({ name: "Ana", races: 3 })
  })

  it("fits a whole club with its definitions, and says how to page when it doesn't", () => {
    const members = Array.from({ length: 110 }, (_, i) =>
      compactRow({
        name: `Member Number ${i}`,
        email: `member.number.${i}@utexas.edu`,
        eid: i % 9 === 0 ? `ab${10000 + i}` : null,
        joined: "2026-02-14",
        roles: i < 21 ? ["officer"] : [],
        eventsRegistered: i % 4,
        checkIns: 0,
        racesDriven: i % 7,
        lsc: i < 14 ? "form only" : null,
        paidDollars: i % 5 === 0 ? 25 : 0,
      }),
    )
    const text = forModelWithLists({ rosterDefinitions: "what the fields mean" }, [{ key: "roster", items: members, whenTrimmed: "Page with joinedFrom." }])
    const body = JSON.parse(text)
    expect(text.length).toBeLessThanOrEqual(MAX_MODEL_CHARS)
    expect(body.roster).toHaveLength(110)
    expect(body.rosterDefinitions).toBe("what the fields mean")

    const many = Array.from({ length: 400 }, (_, i) => ({ name: `Member ${i}`, email: `m${i}@utexas.edu`, joined: "2026-02-14", note: "x".repeat(40) }))
    const trimmed = JSON.parse(forModelWithLists({ rosterDefinitions: "kept" }, [{ key: "roster", items: many, whenTrimmed: "Page with joinedFrom." }]))
    expect(trimmed.rosterDefinitions).toBe("kept")
    expect(trimmed.rosterNote).toMatch(/^Only the first \d+ of 400 roster fit in this reply\. Page with joinedFrom\.$/)
  })
})

describe("club_members: the roster and the newest members", () => {
  const newest = [{ name: "Newest One", joined: "Mon 2026-10-12 18:00 CT" }]
  const signups = [{ period: "2026-10", signups: 3 }]
  const member = (i: number, pad = 0) => ({ name: `Member ${i}`, email: `m${i}@utexas.edu`, joined: "2026-02-14", ...(pad ? { note: "x".repeat(pad) } : {}) })

  it("leaves the newest list out when the whole club fits, and says why", () => {
    const body = JSON.parse(membersForModel({}, { roster: { rows: [member(1), { ...member(2), eid: "ab123" }], definitions: "defs", kind: "members" }, wholeClub: true, newest, signups }))
    expect(body.roster).toHaveLength(2)
    expect(body.newest).toBe("left out: the roster has everyone, oldest first")
    expect(body.rosterCounts).toEqual({ people: 2, withEmail: 2, withEid: 1 })
  })

  it("puts the newest members first when the roster is cut short (its newest rows are the ones cut)", () => {
    const rows = Array.from({ length: 300 }, (_, i) => member(i, 60))
    const body = JSON.parse(membersForModel({}, { roster: { rows, definitions: "defs", kind: "members" }, wholeClub: true, newest, signups }))
    expect(body.newest).toEqual(newest)
    expect(body.rosterNote).toMatch(/Ask again with joinedFrom and joinedTo/)
    expect(body.rosterDefinitions).toBe("defs")
  })

  it("keeps the newest list for officers and filtered rosters", () => {
    for (const roster of [
      { rows: [member(1)], definitions: "defs", kind: "officers" as const },
      { rows: [member(1)], definitions: "defs", kind: "members" as const },
    ]) {
      expect(JSON.parse(membersForModel({}, { roster, wholeClub: false, newest, signups })).newest).toEqual(newest)
    }
  })
})
