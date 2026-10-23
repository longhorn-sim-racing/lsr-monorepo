import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type Ev = { id: string; slug: string; title: string; summary: string | null; startsAtUtc: Date; endsAtUtc: Date; status: string; visibility: string; publishedAt: Date | null; updatedAt: Date; registrationEnabled: boolean; registrationClosesAt: Date | null; series: { slug: string } | null; venue: { name: string; room: string | null } | null; meetingUrl?: string }
type Mirror = { eventId: string; discordEventId: string; eventStartsAt: Date; lastSyncedAt: Date; interestedCount: number | null }

const state = vi.hoisted(() => ({ events: [] as unknown[], mirrors: [] as unknown[], rule: null as unknown }))
vi.mock("@/server/db", () => ({
  prisma: {
    discordRule: { findFirst: async () => state.rule },
    // The mirror's own where (public, upcoming) is Postgres's job; these tests hand it the events it would get
    event: {
      findMany: async () => (state.events as Ev[]).filter((e) => e.status !== "DRAFT"),
      findUnique: async ({ where }: { where: { id: string } }) => (state.events as Ev[]).find((e) => e.id === where.id) ?? null,
    },
    discordEventMirror: {
      findMany: async () => (state.mirrors as Mirror[]).map((m) => ({ ...m })),
      create: async ({ data }: { data: Mirror }) => (state.mirrors as Mirror[]).push({ ...data }),
      update: async ({ where, data }: { where: { eventId: string }; data: Partial<Mirror> }) => Object.assign((state.mirrors as Mirror[]).find((m) => m.eventId === where.eventId)!, data),
      delete: async ({ where }: { where: { eventId: string } }) => {
        state.mirrors = (state.mirrors as Mirror[]).filter((m) => m.eventId !== where.eventId)
      },
      updateMany: async ({ where, data }: { where: { discordEventId: string }; data: { interestedCount: number } }) => {
        const hit = (state.mirrors as Mirror[]).filter((m) => m.discordEventId === where.discordEventId && m.interestedCount !== data.interestedCount)
        hit.forEach((m) => (m.interestedCount = data.interestedCount))
        return { count: hit.length }
      },
    },
  },
}))

import { mountFakes, type MountedFakes } from "@/server/connectors/fakes/testing"
import { discordClient } from "@/server/connectors/discord/client"
import { FAKE_DISCORD } from "@/server/connectors/discord/fake/data"
import { discordFake } from "@/server/connectors/discord/fake/handlers"
import { DiscordRateLimiter } from "@/server/connectors/discord/rate-limit"
import { discordWriter } from "@/server/connectors/discord/write"
import { runEventMirror, scheduledEventFor } from "./event-mirror"

const SITE = "https://www.longhornsimracing.org"
const DAY = 86_400_000

afterEach(() => {
  vi.unstubAllGlobals()
})

let fakes: MountedFakes
let writer: ReturnType<typeof discordWriter>
beforeEach(() => {
  fakes = mountFakes([discordFake])
  const client = discordClient({ token: FAKE_DISCORD.botToken, guildId: FAKE_DISCORD.guildId, limiter: new DiscordRateLimiter() })
  writer = discordWriter(client.rest, client.guildId)
  state.rule = { id: "mirror", kind: "event_mirror", config: { location: "Online" }, cutoffAt: new Date(Date.now() - DAY), enabled: true }
  state.mirrors = []
  state.events = []
})

function event(id: string, over: Partial<Ev> = {}): Ev {
  const start = new Date(Date.now() + 3 * DAY)
  return { id, slug: id, title: `Event ${id}`, summary: "Bring a friend", startsAtUtc: start, endsAtUtc: new Date(start.getTime() + 7_200_000), status: "PUBLISHED", visibility: "public", publishedAt: new Date(Date.now() - DAY), updatedAt: new Date(Date.now() - DAY), registrationEnabled: false, registrationClosesAt: null, series: null, venue: { name: "Alienware Lounge", room: null }, meetingUrl: "https://zoom.example/j/1", ...over }
}
const run = () => runEventMirror(writer, { now: new Date(), log: () => {}, siteUrl: SITE })
const discordEvents = async () => ((await (await fetch(`${fakes.origin}/discord/_fake/writes`)).json()) as { events: { id: string; name: string; description: string; entity_metadata: { location: string }; user_count: number }[] }).events

describe("the Discord event for one of ours", () => {
  it("is external, with the public facts and the event page, never the meeting link", () => {
    const input = scheduledEventFor(event("gm-2", { title: "GM 2 @everyone https://x.example" }), { siteUrl: SITE, location: null })
    expect(input).toMatchObject({ name: "GM 2 everyone", channel_id: null, privacy_level: 2, entity_type: 3, entity_metadata: { location: "Alienware Lounge" } })
    expect(input.description).toBe(`Bring a friend\n\nDetails and registration: ${SITE}/events/gm-2`)
    expect(JSON.stringify(input)).not.toContain("zoom.example")
    // No venue: the rule's location, else a pointer to the site
    expect(scheduledEventFor(event("x", { venue: null }), { siteUrl: SITE, location: "Online" }).entity_metadata.location).toBe("Online")
    // Starts and ends at the same time: Discord needs an end after the start
    const same = event("y")
    same.endsAtUtc = same.startsAtUtc
    const fixed = scheduledEventFor(same, { siteUrl: SITE })
    expect(Date.parse(fixed.scheduled_end_time)).toBeGreaterThan(Date.parse(fixed.scheduled_start_time))
  })
})

describe("the event mirror", () => {
  it("does nothing without a switched-on rule", async () => {
    state.rule = null
    expect((await run()).status).toBe("no-rule")
  })

  it("adds public events, edits one that changed, takes off one that was cancelled, and reads interested counts", async () => {
    state.events = [event("a"), event("b"), event("draft", { status: "DRAFT" }), event("members", { visibility: "members" })]
    const first = await run()
    expect(first).toMatchObject({ created: 2, updated: 0, removed: 0 })
    expect((await discordEvents()).map((e) => e.name).sort()).toEqual(["Event a", "Event b"])

    // a is renamed; b is cancelled
    const [a, b] = state.events as Ev[]
    a.title = "Event a (new night)"
    a.updatedAt = new Date()
    b.status = "CANCELLED"
    const mirrorA = (state.mirrors as Mirror[]).find((m) => m.eventId === "a")!
    await fetch(`${fakes.origin}/discord/_fake/interested`, { method: "POST", body: JSON.stringify({ eventId: mirrorA.discordEventId, count: 7 }) })
    const second = await run()
    expect(second).toMatchObject({ created: 0, updated: 1, removed: 1, counted: 1 })
    expect((await discordEvents()).map((e) => e.name)).toEqual(["Event a (new night)"])
    expect((state.mirrors as Mirror[]).map((m) => [m.eventId, m.interestedCount])).toEqual([["a", 7]])

    // Nothing changed: no writes
    const before = fakes.requests.length
    const third = await run()
    expect(third).toMatchObject({ created: 0, updated: 0, removed: 0 })
    expect(fakes.requests.slice(before).every((r) => r.method === "GET")).toBe(true)
  })

  it("never makes a second Discord event when a create's answer was lost: the next run finds the first and keeps it", async () => {
    state.events = [event("a")]
    await fetch(`${fakes.origin}/discord/_fake/drop`, { method: "POST", body: JSON.stringify({ path: "/scheduled-events", when: "after", times: 1 }) })
    await expect(run()).rejects.toThrow()
    expect(state.mirrors).toEqual([])
    expect(await discordEvents()).toHaveLength(1)

    const again = await run()
    expect(again).toMatchObject({ created: 0 })
    const listed = await discordEvents()
    expect(listed).toHaveLength(1)
    expect((state.mirrors as Mirror[]).map((m) => [m.eventId, m.discordEventId])).toEqual([["a", listed[0].id]])
  })

  it("leaves an event an admin deleted in Discord deleted", async () => {
    state.events = [event("a")]
    await run()
    const mirror = (state.mirrors as Mirror[])[0]
    await writer.deleteScheduledEvent(mirror.discordEventId, "by hand")
    ;(state.events as Ev[])[0].updatedAt = new Date()
    const result = await run()
    expect(result).toMatchObject({ gone: 1, created: 0 })
    expect(await discordEvents()).toEqual([])
  })
})
