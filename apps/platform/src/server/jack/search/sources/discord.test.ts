import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  connectorState: { findUnique: vi.fn() },
  discordChannel: { findMany: vi.fn() },
  systemSetting: { findUnique: vi.fn() },
}))
vi.mock("@/server/db", () => ({ prisma: db }))

import { mountFakes, type MountedFakes } from "@/server/connectors/fakes/testing"
import { FAKE_CHANNELS, FAKE_DISCORD, FAKE_INJECTION } from "@/server/connectors/discord/fake/data"
import { discordFake } from "@/server/connectors/discord/fake/handlers"
import { authorHash } from "@/server/connectors/discord/metadata"
import { hitLink } from "../../tools/search"
import { search } from "../search"
import { DISCORD_INDEXING, DISCORD_NO_CHANNELS, discordMessageHref, discordQuery, discordSource } from "./discord"

const THREAD = "thread-row"

let fakes: MountedFakes

beforeEach(() => {
  fakes = mountFakes([discordFake])
  vi.stubEnv("DISCORD_BOT_TOKEN", FAKE_DISCORD.botToken)
  vi.stubEnv("DISCORD_GUILD_ID", FAKE_DISCORD.guildId)
  vi.stubEnv("DISCORD_CLIENT_ID", FAKE_DISCORD.clientId)
  vi.stubEnv("DISCORD_CLIENT_SECRET", FAKE_DISCORD.clientSecret)
  db.connectorState.findUnique.mockResolvedValue({ id: "discord", enabled: true })
  db.discordChannel.findMany.mockResolvedValue([
    { id: FAKE_CHANNELS.general, name: "general", parentId: null, synced: true },
    { id: FAKE_CHANNELS.lscChat, name: "lsc-chat", parentId: null, synced: true },
    { id: FAKE_CHANNELS.announcements, name: "announcements", parentId: null, synced: false },
    { id: THREAD, name: "Monza setup help", parentId: FAKE_CHANNELS.general, synced: false },
  ])
  db.systemSetting.findUnique.mockResolvedValue(null)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const hook = (path: string, body: unknown) => fetch(`${fakes.origin}/discord/_fake/${path}`, { method: "POST", body: JSON.stringify(body) })
const searches = () => fakes.requests.filter((r) => r.path.endsWith("/messages/search"))

describe("discordQuery", () => {
  it("sends words and phrases, drops or and quotes, and keeps -words to filter out", () => {
    expect(discordQuery('lsc "race night" or schedule -spa')).toEqual({ content: "lsc race night schedule", without: ["spa"] })
    expect(discordQuery("-only -excluded")).toEqual({ content: "", without: ["only", "excluded"] })
  })
})

describe("the Discord search source", () => {
  it("is unavailable while Discord is off, and while no channel is opted in", async () => {
    db.connectorState.findUnique.mockResolvedValue({ id: "discord", enabled: false })
    expect(await discordSource.unavailable!()).toMatch(/Discord isn't connected/)
    db.connectorState.findUnique.mockResolvedValue({ id: "discord", enabled: true })
    db.discordChannel.findMany.mockResolvedValue([{ id: FAKE_CHANNELS.general, name: "general", parentId: null, synced: false }])
    expect(await discordSource.unavailable!()).toBe(DISCORD_NO_CHANNELS)
    expect(fakes.requests).toHaveLength(0)
  })

  it("searches only the opted-in channels and their threads, live, and hands the text to the model only", async () => {
    const hits = await discordSource.search({ query: "lsc", limit: 10, includeJackReplies: false })
    expect(hits.length).toBeGreaterThan(0)
    const asked = new URL(searches().at(-1)!.url).searchParams
    expect(asked.getAll("channel_id").sort()).toEqual([FAKE_CHANNELS.general, FAKE_CHANNELS.lscChat, THREAD].sort())
    expect(asked.get("content")).toBe("lsc")
    for (const hit of hits) {
      expect([FAKE_CHANNELS.general, FAKE_CHANNELS.lscChat]).toContain(hit.id.split("/")[0])
      expect(hit).toMatchObject({ source: "discord", type: "discord_message", modelOnly: true, meta: { kind: "Discord", by: expect.any(String) } })
      expect(hit.url).toBe(discordMessageHref(FAKE_DISCORD.guildId, hit.id.split("/")[0], hit.id.split("/")[1]))
      expect(hit.snippet.toLowerCase()).toContain("lsc")
      // The room's link has no text from Discord
      expect(hitLink(hit).snippet).toBeUndefined()
      expect(hitLink(hit).meta).toMatch(/^Discord · /)
    }
    expect(hits.map((h) => h.rank)).toEqual([...hits.map((h) => h.rank)].sort((a, b) => b - a))
    expect(hits[0].rank).toBeLessThanOrEqual(0.3)
  })

  it("filters out -words, and members whose data was purged", async () => {
    const all = await discordSource.search({ query: "lsc", limit: 25, includeJackReplies: false })
    const withSchedule = all.filter((h) => h.snippet.toLowerCase().includes("schedule"))
    expect(withSchedule.length).toBeGreaterThan(0)
    const without = await discordSource.search({ query: "lsc -schedule", limit: 25, includeJackReplies: false })
    expect(without.some((h) => h.snippet.toLowerCase().includes("schedule"))).toBe(false)

    const injected = all.find((h) => h.snippet.includes(FAKE_INJECTION.marker))!
    const author = (await (await fetch(`${fakes.origin}/discord/api/v10/channels/${FAKE_CHANNELS.lscChat}/messages/${injected.id.split("/")[1]}`, { headers: { authorization: `Bot ${FAKE_DISCORD.botToken}` } })).json()) as { author: { id: string } }
    db.systemSetting.findUnique.mockResolvedValue({ key: "discord_purged", value: JSON.stringify({ authors: [authorHash(author.author.id)] }) })
    const after = await discordSource.search({ query: "lsc", limit: 25, includeJackReplies: false })
    expect(after.some((h) => h.id === injected.id)).toBe(false)
  })

  it("says so when Discord's index isn't ready, as the source's reason", async () => {
    await hook("search", { ready: false, stuck: true })
    const { hits, outcomes } = await search({ query: "monza", sources: ["discord"], limit: 5, registry: [discordSource] })
    expect(hits).toEqual([])
    expect(outcomes).toEqual([{ source: "discord", status: "failed", reason: DISCORD_INDEXING }])
  })
})

describe("reading a Discord conversation", () => {
  const reader = discordSource.readers[0]

  it("opens a message with the ones around it, marking it", async () => {
    const [hit] = await discordSource.search({ query: "lsc", limit: 1, includeJackReplies: false })
    const result = await reader.read(hit.id, {})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.doc).toMatchObject({ type: "discord_message", id: hit.id, url: hit.url, meta: { kind: "Discord" } })
    expect(result.doc.title).toMatch(/^Conversation in #/)
    expect(result.doc.text).toContain("→ (the message you opened)")
    expect(result.doc.text.split("\n\n").length).toBeGreaterThan(2)
    expect(fakes.requests.at(-1)?.url).toContain(`around=${hit.id.split("/")[1]}`)
  })

  it("refuses ids that aren't ones, channels that aren't opted in, and messages that are gone", async () => {
    expect(await reader.read("../../users", {})).toEqual({ ok: false, error: expect.stringMatching(/isn't a Discord message id/) })
    expect(await reader.read(`${FAKE_CHANNELS.announcements}/${FAKE_CHANNELS.general}`, {})).toEqual({ ok: false, error: expect.stringMatching(/isn't opted in/) })
    expect(await reader.read(`${FAKE_CHANNELS.general}/1300000000000000555`, {})).toEqual({ ok: false, error: expect.stringMatching(/may have been deleted/) })
  })

  it("says Discord isn't connected while it's off", async () => {
    db.connectorState.findUnique.mockResolvedValue(null)
    expect(await reader.read(`${FAKE_CHANNELS.general}/1300000000000000555`, {})).toEqual({ ok: false, error: expect.stringMatching(/Discord isn't connected/) })
  })
})
