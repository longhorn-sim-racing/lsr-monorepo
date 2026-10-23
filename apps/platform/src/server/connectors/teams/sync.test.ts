import { afterEach, describe, expect, it, vi } from "vitest"
import { mountFakes } from "../fakes/testing"
import { GRAPH_FAKE } from "../microsoft/fake/fixtures"
import { microsoftGraphFake } from "../microsoft/fake/handlers"
import { graphClient } from "../microsoft/graph"
import { syncTeams, type TeamsCursor, type TeamsSyncOptions } from "./sync"
import { memoryTeamsStore } from "./testing"

afterEach(() => {
  vi.unstubAllGlobals()
})

const { general, sponsorship } = GRAPH_FAKE.channels

function setup() {
  const fakes = mountFakes([microsoftGraphFake])
  const store = memoryTeamsStore()
  const run = (cursor: TeamsCursor | null | undefined, extra: Partial<TeamsSyncOptions> = {}) =>
    syncTeams({
      graph: graphClient({ tenantId: GRAPH_FAKE.tenantId, clientId: GRAPH_FAKE.clientId, clientSecret: GRAPH_FAKE.clientSecret }, { retryDelayMs: 0 }),
      teamId: GRAPH_FAKE.teamId,
      channelIds: [general, sponsorship],
      store,
      cursor,
      signal: new AbortController().signal,
      deadline: Date.now() + 60_000,
      channelIntervalMs: 0,
      ...extra,
    })
  const hook = (path: string, body: unknown) => fetch(`${fakes.origin}/microsoft-graph/_fake/${path}`, { method: "POST", body: JSON.stringify(body) })
  return { fakes, store, run, hook }
}

describe("a channel's first Teams sync", () => {
  it("copies every thread with its replies as text, skipping system events, keeping no text of deleted messages", async () => {
    const { store, run } = setup()
    const { counts, cursor, more } = await run(null)
    expect(more).toBe(false)
    expect(cursor.backfill).toEqual({})
    expect(store.channels.get(general)).toMatchObject({ name: "General", teamId: GRAPH_FAKE.teamId, synced: true, deltaLink: expect.stringContaining("/messages/delta?$deltatoken=") })
    expect(store.channels.get(sponsorship)!.name).toBe("Sponsorship")

    expect(store.messages.get("1760454600000")).toMatchObject({ channelId: general, replyToId: "1760454000000", authorName: "Fixture Officer B", authorAadId: "aad-fixture-b", content: "I do. @Fixture Officer A, grab it from me before Friday." })
    expect(store.messages.get("1760540000000")!.content).toBe("Fixture Motors confirmed the sponsor call for Thursday at 4 PM in the engineering lounge.")
    expect(store.messages.get("1760540600000")!.content).toBe("Great, I'll bring the pitch deck (https://example.com/fixture-deck).")
    expect(store.messages.get("1760541000000")!.authorName).toBe("Fixture Reminders")
    expect(store.messages.has("1760455000000")).toBe(false)
    expect(store.messages.get("1760456000000")).toMatchObject({ content: "", deletedAt: expect.any(Date) })
    expect(counts).toMatchObject({ channels: 2, deleted: 1 })
  })

  it("follows a thread's further replies, and the listing's pages", async () => {
    const { store, run, hook } = setup()
    await hook("config", { repliesPageSize: 0 })
    await hook("mutate", { op: "reply", channelId: sponsorship, messageId: "1760540000000", id: "1760600000000", text: "<p>Confirmed with the lounge.</p>" })
    await run(null)
    expect(store.messages.get("1760540600000")).toBeTruthy()
    expect(store.messages.get("1760600000000")).toMatchObject({ replyToId: "1760540000000", content: "Confirmed with the lounge." })
  })

  it("stops at the deadline and carries on from the cursor", async () => {
    const { store, run } = setup()
    const stopped = await run(null, { deadline: Date.now() - 1 })
    expect(stopped.more).toBe(true)
    expect(store.messages.size).toBe(0)
    const done = await run(stopped.cursor)
    expect(done.more).toBe(false)
    expect(store.messages.size).toBeGreaterThan(4)
  })
})

describe("the daily reconcile", () => {
  it("follows the delta link: new replies, edits and deletions", async () => {
    const { store, run, hook } = setup()
    const first = await run(null)
    await hook("mutate", { op: "reply", channelId: general, messageId: "1760454000000", id: "1760700000000", text: "Key's in the lockbox now." })
    await hook("mutate", { op: "edit", channelId: sponsorship, messageId: "1760540000000", text: "<p>Fixture Motors moved the call to Friday at 2 PM.</p>" })
    await hook("mutate", { op: "delete", channelId: general, messageId: "1760454000000", replyId: "1760454600000" })
    await run(first.cursor)
    expect(store.messages.get("1760700000000")).toMatchObject({ replyToId: "1760454000000", content: "Key's in the lockbox now." })
    expect(store.messages.get("1760540000000")).toMatchObject({ content: "Fixture Motors moved the call to Friday at 2 PM.", editedAt: expect.any(Date) })
    expect(store.messages.get("1760454600000")).toMatchObject({ content: "", deletedAt: expect.any(Date) })
  })

  it("stops syncing a channel taken out of MS_CHANNEL_IDS and deletes its messages", async () => {
    const { store, run } = setup()
    const first = await run(null)
    const result = await run(first.cursor, { channelIds: [general] })
    expect(result.counts).toMatchObject({ droppedChannels: 1, droppedMessages: 3 })
    expect(store.channels.get(sponsorship)).toMatchObject({ synced: false, deltaLink: null })
    expect([...store.messages.values()].some((m) => m.channelId === sponsorship)).toBe(false)
  })

  it("keeps calls on one channel a second apart (Graph's per-channel limit)", async () => {
    const { store, run, hook } = setup()
    await hook("config", { enforcePacing: true })
    const started = Date.now()
    await run(null, { channelIds: [general], channelIntervalMs: 1_050 })
    expect(store.channels.get(general)?.deltaLink).toBeTruthy()
    // Name, listing, delta: three calls, two waits
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_000)
  })
})
