import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DiscordRule } from "@prisma/client"
import { fakePostTable, postRow, type FakePostTable } from "./fake-posts"

/** Event rows as rules read them (never meetingUrl), filtered by a small where-matcher like Postgres would */
type Ev = {
  id: string
  slug: string
  title: string
  summary: string | null
  startsAtUtc: Date
  endsAtUtc: Date
  status: string
  visibility: string
  publishedAt: Date | null
  createdAt: Date
  updatedAt: Date
  registrationEnabled: boolean
  registrationClosesAt: Date | null
  series: { slug: string } | null
  venue: { name: string; room: string | null } | null
}

function matchField(value: unknown, filter: unknown): boolean {
  if (filter === null) return value === null
  if (filter instanceof Date) return value instanceof Date && value.getTime() === filter.getTime()
  if (typeof filter !== "object") return value === filter
  const f = filter as Record<string, unknown>
  const t = (v: unknown) => (v instanceof Date ? v.getTime() : NaN)
  if ("in" in f && !(f.in as unknown[]).includes(value)) return false
  if ("notIn" in f && (f.notIn as unknown[]).includes(value)) return false
  if ("gt" in f && !(value instanceof Date && t(value) > t(f.gt))) return false
  if ("gte" in f && !(value instanceof Date && t(value) >= t(f.gte))) return false
  if ("lt" in f && !(value instanceof Date && t(value) < t(f.lt))) return false
  if ("lte" in f && !(value instanceof Date && t(value) <= t(f.lte))) return false
  if ("slug" in f) return (value as { slug?: string } | null)?.slug === f.slug
  return true
}
function matchEvent(row: Ev, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, filter]) => {
    if (key === "AND") return (filter as Record<string, unknown>[]).every((w) => matchEvent(row, w))
    if (key === "OR") return (filter as Record<string, unknown>[]).some((w) => matchEvent(row, w))
    return matchField((row as Record<string, unknown>)[key], filter)
  })
}

const state = vi.hoisted(() => ({
  events: [] as unknown[],
  rules: [] as unknown[],
  audits: [] as unknown[],
  raceSessions: new Map<string, unknown>(),
  entries: [] as unknown[],
  league: { id: "league-lsc", visibility: "public" } as { id: string; visibility: string } | null,
  seasons: new Map<string, unknown>(),
  streams: [] as unknown[],
  live: null as unknown,
  /** Each stream's newest viewer sample (streamLastSeen), by id */
  lastSeen: {} as Record<string, Date>,
  posting: ["1100000000000000001"],
}))
const db = vi.hoisted(() => ({ prisma: {} as Record<string, unknown> }))
vi.mock("@/server/db", () => db)
vi.mock("@/server/connectors/twitch/streams", () => ({ currentLiveStream: async () => state.live, streamLastSeen: async (s: { id: string; startedAt: Date }) => state.lastSeen[s.id] ?? s.startedAt }))

import { LOOK_BACK_MS, MAX_NEW_PER_RUN, MAX_REMINDERS_PER_RUN, parseRuleKey, REMINDER_GRACE_MS, ruleKey, rulePostProblem, runDiscordRules, stableJson } from "./rule-runner"

const SITE = "https://www.longhornsimracing.org"
const CHANNEL = "1100000000000000001"
const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = new Date("2026-10-23T17:00:00Z")
let posts: FakePostTable

function event(id: string, over: Partial<Ev> = {}): Ev {
  const start = over.startsAtUtc ?? new Date(NOW.getTime() + 2 * DAY)
  return { id, slug: id, title: `Event ${id}`, summary: null, startsAtUtc: start, endsAtUtc: new Date(start.getTime() + 2 * HOUR), status: "PUBLISHED", visibility: "public", publishedAt: new Date(NOW.getTime() - HOUR), createdAt: new Date(NOW.getTime() - 2 * DAY), updatedAt: NOW, registrationEnabled: false, registrationClosesAt: null, series: null, venue: { name: "Lounge", room: null }, ...over }
}

function rule(kind: string, config: Record<string, unknown>, over: Partial<DiscordRule> = {}): DiscordRule {
  return { id: `rule-${kind}`, kind, channelId: CHANNEL, config: config as DiscordRule["config"], enabled: true, cutoffAt: new Date(NOW.getTime() - 2 * HOUR), createdById: null, updatedById: null, createdAt: new Date(NOW.getTime() - DAY), updatedAt: NOW, ...over }
}

const events = () => state.events as Ev[]
const run = (now = NOW) => runDiscordRules({ now, log: () => {}, siteUrl: SITE })

beforeEach(() => {
  posts = fakePostTable()
  Object.assign(state, { events: [], rules: [], audits: [], raceSessions: new Map(), entries: [], league: { id: "league-lsc", visibility: "public" }, seasons: new Map(), streams: [], live: null, lastSeen: {}, posting: [CHANNEL] })
  db.prisma = {
    discordPost: posts,
    systemSetting: { findUnique: async () => ({ value: JSON.stringify({ channels: state.posting }) }) },
    discordRule: {
      findMany: async ({ where }: { where: { enabled?: boolean } }) => (state.rules as DiscordRule[]).filter((r) => where.enabled === undefined || r.enabled === where.enabled).filter((r) => r.kind !== "event_mirror"),
      findUnique: async ({ where }: { where: { id: string } }) => (state.rules as DiscordRule[]).find((r) => r.id === where.id) ?? null,
    },
    event: {
      findMany: async ({ where, take }: { where: Record<string, unknown>; take?: number }) => events().filter((e) => matchEvent(e, where)).sort((a, b) => a.startsAtUtc.getTime() - b.startsAtUtc.getTime()).slice(0, take ?? Infinity),
      findUnique: async ({ where }: { where: { id: string } }) => events().find((e) => e.id === where.id) ?? null,
    },
    auditLog: {
      findMany: async ({ where }: { where: { actionType: string; entityType: string; createdAt: { gt: Date } } }) =>
        (state.audits as { actionType: string; entityType: string; createdAt: Date }[]).filter((a) => a.actionType === where.actionType && a.entityType === where.entityType && a.createdAt > where.createdAt.gt).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    },
    raceSession: { findFirst: async ({ where }: { where: { eventId: string } }) => state.raceSessions.get(where.eventId) ?? null },
    league: { findUnique: async () => state.league },
    season: { findUnique: async ({ where }: { where: { id: string } }) => state.seasons.get(where.id) ?? null },
    entry: { findMany: async ({ take }: { take: number }) => (state.entries as unknown[]).slice(0, take) },
    twitchStream: { findFirst: async ({ where }: { where: { startedAt: { lt: Date } } }) => (state.streams as { startedAt: Date }[]).filter((s) => s.startedAt < where.startedAt.lt).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0] ?? null },
  }
})

const scheduled = () => posts.rows.filter((r) => r.status === "SCHEDULED")

describe("event reminders", () => {
  it("schedule a reminder per offset for public events only, after the cutoff and within the grace", async () => {
    state.rules = [rule("event_reminder", { offsets: [1440, 60] })]
    state.events = [
      event("public"),
      event("draft", { status: "DRAFT" }),
      event("members", { visibility: "members" }),
      event("not-yet", { status: "SCHEDULED", publishedAt: new Date(NOW.getTime() + DAY) }),
      event("cancelled", { status: "CANCELLED" }),
      // 1 hour before is 30 minutes ago: past the grace; a day before is long gone
      event("soon", { startsAtUtc: new Date(NOW.getTime() + 30 * 60_000) }),
      // 1 hour before is in 10 minutes
      event("next", { startsAtUtc: new Date(NOW.getTime() + HOUR + 10 * 60_000) }),
    ]
    const result = await run()
    expect(result).toMatchObject({ rules: 1, queued: 3, errors: [] })
    const keys = scheduled().map((p) => parseRuleKey(p.dedupeKey))
    expect(keys.map((k) => k && "eventId" in k && k.eventId).sort()).toEqual(["next", "public", "public"])
    const publicReminders = scheduled().filter((p) => p.dedupeKey?.includes(":public:"))
    expect(publicReminders.map((p) => p.scheduledFor.getTime()).sort()).toEqual([NOW.getTime() + DAY, NOW.getTime() + 2 * DAY - HOUR])
    expect(publicReminders.every((p) => p.source === "rule" && p.ruleId === "rule-event_reminder" && p.channelId === CHANNEL)).toBe(true)
    // Nothing pings: the rule names no ping
    expect(publicReminders.every((p) => stableJson((p.content as { allowed_mentions: unknown }).allowed_mentions) === stableJson({ parse: [] }))).toBe(true)
  })

  it("never remind about a time before the rule's cutoff (switched on later than that)", async () => {
    state.rules = [rule("event_reminder", { offsets: [60] }, { cutoffAt: new Date(NOW.getTime() - 5 * 60_000) })]
    // Its reminder time was 10 minutes ago: inside the grace, but before the cutoff
    state.events = [event("e", { startsAtUtc: new Date(NOW.getTime() + 50 * 60_000) })]
    expect((await run()).queued).toBe(0)
    expect(REMINDER_GRACE_MS).toBeGreaterThan(10 * 60_000)
  })

  it("are keyed by the start time: a moved event's reminders are cancelled and new ones made; moved back, the first ones come back", async () => {
    state.rules = [rule("event_reminder", { offsets: [1440, 60] })]
    state.events = [event("gm")]
    await run()
    const first = scheduled().map((p) => p.dedupeKey).sort()
    expect(first).toHaveLength(2)

    events()[0].startsAtUtc = new Date(NOW.getTime() + 3 * DAY)
    const moved = await run()
    expect(moved).toMatchObject({ queued: 2, cancelled: 2 })
    const cancelled = posts.rows.filter((r) => r.status === "CANCELLED")
    expect(cancelled.every((r) => r.dedupeKey === null && /moved to/.test(r.error ?? ""))).toBe(true)
    expect(scheduled().map((p) => p.dedupeKey).every((k) => k?.includes(new Date(NOW.getTime() + 3 * DAY).toISOString()))).toBe(true)

    events()[0].startsAtUtc = new Date(NOW.getTime() + 2 * DAY)
    const back = await run()
    expect(back).toMatchObject({ queued: 2, cancelled: 2 })
    expect(scheduled().map((p) => p.dedupeKey).sort()).toEqual(first)
  })

  it("cancel the pending reminders of an event that was cancelled or unpublished", async () => {
    state.rules = [rule("event_reminder", { offsets: [1440] })]
    state.events = [event("a"), event("b")]
    await run()
    events()[0].status = "CANCELLED"
    events()[1].status = "DRAFT"
    const result = await run()
    expect(result.cancelled).toBe(2)
    expect(posts.rows.map((r) => r.error)).toEqual(["“Event a” was cancelled.", "“Event b” isn't public on the site."])
  })

  it("say what's true now: a pending reminder follows a new title or venue", async () => {
    state.rules = [rule("event_reminder", { offsets: [1440] })]
    state.events = [event("a")]
    await run()
    events()[0].venue = { name: "New Lounge", room: "2.1" }
    expect((await run()).refreshed).toBe(1)
    expect(JSON.stringify(scheduled()[0].content)).toContain("New Lounge, 2.1")
    expect((await run()).refreshed).toBe(0)
  })

  it("schedule at most a set number a run; the rest on the next", async () => {
    state.rules = [rule("event_reminder", { offsets: [60] })]
    state.events = Array.from({ length: MAX_REMINDERS_PER_RUN + 5 }, (_, i) => event(`e${i}`, { startsAtUtc: new Date(NOW.getTime() + 2 * HOUR + i * 60_000) }))
    expect((await run()).queued).toBe(MAX_REMINDERS_PER_RUN)
    expect((await run()).queued).toBe(5)
    expect((await run()).queued).toBe(0)
  })
})

describe("new events", () => {
  it("announce upcoming public events published after the cutoff, at most a few a run, once each", async () => {
    state.rules = [rule("new_event", {})]
    state.events = [
      event("old", { publishedAt: new Date(NOW.getTime() - 3 * HOUR) }),
      event("draft", { status: "DRAFT" }),
      event("past", { startsAtUtc: new Date(NOW.getTime() - HOUR) }),
      ...Array.from({ length: MAX_NEW_PER_RUN + 1 }, (_, i) => event(`new${i}`, { publishedAt: new Date(NOW.getTime() - 30 * 60_000 + i) })),
    ]
    expect((await run()).queued).toBe(MAX_NEW_PER_RUN)
    expect((await run()).queued).toBe(1)
    expect((await run()).queued).toBe(0)
    expect(posts.rows.map((r) => r.dedupeKey).sort()).toEqual(Array.from({ length: MAX_NEW_PER_RUN + 1 }, (_, i) => ruleKey.newEvent("rule-new_event", `new${i}`)).sort())
  })

  it("look back only so far, even when the rule's cutoff is older (a scheduler that stopped never floods the channel)", async () => {
    state.rules = [rule("new_event", {}, { cutoffAt: new Date(NOW.getTime() - 30 * DAY) })]
    state.events = [event("week-old", { publishedAt: new Date(NOW.getTime() - LOOK_BACK_MS - HOUR) }), event("fresh", { publishedAt: new Date(NOW.getTime() - HOUR) })]
    await run()
    expect(posts.rows.map((r) => r.dedupeKey)).toEqual([ruleKey.newEvent("rule-new_event", "fresh")])
  })
})

describe("results posted", () => {
  it("post a public event's podium once it has race results, once", async () => {
    state.rules = [rule("results_posted", {})]
    state.events = [event("r3", { startsAtUtc: new Date(NOW.getTime() - DAY), title: "LSC Round 3" }), event("hidden", { visibility: "officers" }), event("quali-only")]
    state.audits = ["r3", "hidden", "quali-only"].map((eventId, i) => ({ actionType: "INGEST", entityType: "RESULT_UPLOAD", createdAt: new Date(NOW.getTime() - HOUR + i), metadata: { eventId } }))
    state.raceSessions.set("r3", { trackName: "Monza", results: [{ participant: { displayName: "sim-avery", user: { displayName: "Avery Reyes" } } }, { participant: { displayName: "Blake", user: null } }] })
    state.raceSessions.set("hidden", { trackName: "Spa", results: [] })
    expect((await run()).queued).toBe(1)
    expect((posts.rows[0].content as { content: string }).content).toBe(["Results are up for **LSC Round 3** at Monza.", "", "1. Avery Reyes", "2. Blake", "", `Full results: ${SITE}/events/r3#results`].join("\n"))
    expect((await run()).queued).toBe(0)
  })
})

describe("standings updates", () => {
  beforeEach(() => {
    state.rules = [rule("standings_update", { top: 3 })]
    state.seasons.set("s3", { id: "s3", name: "LSC Season 3", leagueId: "league-lsc", visibility: "public" })
    state.entries = [{ totalPoints: 75, user: { displayName: "Avery" } }, { totalPoints: 60, user: { displayName: "Blake" } }]
    state.audits = [{ id: "recompute-1", entityId: "s3", actionType: "UPDATE", entityType: "SEASON", createdAt: new Date(NOW.getTime() - HOUR) }]
    db.prisma.auditLog = { findMany: async () => state.audits }
  })

  it("post the top of a public LSC season after a recompute, and not again when nothing at the top changed", async () => {
    expect((await run()).queued).toBe(1)
    expect((posts.rows[0].content as { content: string }).content).toContain("1. Avery, 75 pts")
    posts.rows[0].status = "SENT"
    state.audits = [{ id: "recompute-2", entityId: "s3", actionType: "UPDATE", entityType: "SEASON", createdAt: new Date(NOW.getTime() - 30 * 60_000) }]
    expect((await run()).queued).toBe(0)
    state.entries = [{ totalPoints: 80, user: { displayName: "Blake" } }, { totalPoints: 75, user: { displayName: "Avery" } }]
    expect((await run()).queued).toBe(1)
  })

  it("stay quiet for a season outside the public LSC", async () => {
    state.seasons.set("s3", { id: "s3", name: "Private", leagueId: "league-lsc", visibility: "officers" })
    expect((await run()).queued).toBe(0)
    state.league = { id: "league-lsc", visibility: "members" }
    expect((await run()).queued).toBe(0)
  })
})

describe("Twitch live", () => {
  const stream = (id: string, over: Record<string, unknown> = {}) => ({ id, startedAt: new Date(NOW.getTime() - 10 * 60_000), endedAt: null, title: "LSC Round 3 live", gameName: "Assetto Corsa", peakViewers: 0, avgViewers: null, vodId: null, vodViews: null, ...over })

  it("posts the live stream once, with its title stripped of mentions and links", async () => {
    state.rules = [rule("twitch_live", {})]
    state.streams = [stream("s1", { title: "@everyone free https://scam.example" })]
    state.live = state.streams[0]
    expect((await run()).queued).toBe(1)
    const content = (posts.rows[0].content as { content: string }).content
    expect(content).toContain("> everyone free")
    expect(content).not.toContain("scam.example")
    expect((await run()).queued).toBe(0)
  })

  it("waits a moment for the title, skips a reconnect, and never posts a stream that isn't live", async () => {
    state.rules = [rule("twitch_live", {})]
    state.streams = [stream("s1", { title: "", startedAt: new Date(NOW.getTime() - 30_000) })]
    state.live = state.streams[0]
    expect((await run()).queued).toBe(0)
    // A reconnect: the stream before it ended 5 minutes before this one started
    state.streams = [stream("s0", { startedAt: new Date(NOW.getTime() - 2 * HOUR), endedAt: new Date(NOW.getTime() - 15 * 60_000) }), stream("s1")]
    state.live = state.streams[1]
    expect((await run()).queued).toBe(0)
    // Also a reconnect: closed only because this one opened (its end is this one's start), last seen 5 minutes before
    state.streams = [stream("s0", { startedAt: new Date(NOW.getTime() - 2 * HOUR), endedAt: new Date(NOW.getTime() - 10 * 60_000) }), stream("s1")]
    state.lastSeen = { s0: new Date(NOW.getTime() - 15 * 60_000) }
    state.live = state.streams[1]
    expect((await run()).queued).toBe(0)
    // A VOD row the snapshot added (ended), and nothing live
    state.streams = [stream("old", { endedAt: new Date(NOW.getTime() - 5 * 60_000) })]
    state.live = null
    expect((await run()).queued).toBe(0)
    // A stale row (left open while the connector was off, then closed when this one opened) isn't a reconnect: posted
    state.streams = [stream("stale", { startedAt: new Date(NOW.getTime() - 26 * HOUR), endedAt: new Date(NOW.getTime() - 10 * 60_000) }), stream("s2")]
    state.lastSeen = { stale: new Date(NOW.getTime() - 24 * HOUR) }
    state.live = state.streams[1]
    expect((await run()).queued).toBe(1)
    // Live since before the rule was switched on: not news to this rule
    state.streams = [stream("early", { startedAt: new Date(NOW.getTime() - 3 * HOUR) })]
    state.live = state.streams[0]
    expect((await run()).queued).toBe(0)
  })
})

describe("the dispatcher", () => {
  it("skips a rule whose channel isn't a posting channel anymore, or whose settings can't be read", async () => {
    state.rules = [rule("new_event", {}, { id: "r-off-channel", channelId: "1100000000000000999" }), rule("event_reminder", { offsets: "soon" }, { id: "r-broken" })]
    state.events = [event("e")]
    const result = await run()
    expect(result).toMatchObject({ rules: 0, skipped: 2, queued: 0 })
  })
})

describe("the last check before sending a rule's post", () => {
  it("cancels when the rule is off or moved channel, the event moved or started, or the stream ended", async () => {
    const reminder = rule("event_reminder", { offsets: [60] })
    state.rules = [reminder]
    state.events = [event("gm", { startsAtUtc: new Date(NOW.getTime() + 30 * 60_000) })]
    const key = ruleKey.reminder(reminder.id, "gm", events()[0].startsAtUtc, 60)
    const post = postRow({ ruleId: reminder.id, dedupeKey: key, channelId: CHANNEL })
    expect(await rulePostProblem(post, NOW)).toBeNull()
    events()[0].startsAtUtc = new Date(NOW.getTime() + DAY)
    expect(await rulePostProblem(post, NOW)).toMatch(/moved to/)
    events()[0].startsAtUtc = new Date(NOW.getTime() - 60_000)
    expect(await rulePostProblem({ ...post, dedupeKey: ruleKey.reminder(reminder.id, "gm", events()[0].startsAtUtc, 60) }, NOW)).toMatch(/already started/)
    expect(await rulePostProblem({ ...post, channelId: "1100000000000000002" }, NOW)).toBe("Its rule posts in another channel now.")
    reminder.enabled = false
    expect(await rulePostProblem(post, NOW)).toBe("Its rule is switched off.")

    const twitch = rule("twitch_live", {})
    state.rules = [twitch]
    state.live = null
    expect(await rulePostProblem(postRow({ ruleId: twitch.id, dedupeKey: ruleKey.twitch(twitch.id, "s1"), channelId: CHANNEL }), NOW)).toBe("The stream already ended.")
    state.rules = []
    expect(await rulePostProblem(postRow({ ruleId: "gone", channelId: CHANNEL }), NOW)).toBe("Its rule was deleted.")
  })
})
