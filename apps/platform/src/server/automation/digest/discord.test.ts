import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ discordPost: { updateMany: vi.fn() } }))
vi.mock("@/server/db", () => ({ prisma: db }))
const outbox = vi.hoisted(() => ({ queueDiscordPost: vi.fn(), sendPostNow: vi.fn() }))
vi.mock("@/server/discord-post/outbox", () => outbox)
const write = vi.hoisted(() => ({ discordWriter: vi.fn((rest: unknown, guildId: string) => ({ rest, guildId })) }))
vi.mock("@/server/connectors/discord/write", () => write)

import type { DiscordClient } from "@/server/connectors/discord/client"
import { sendDigestToDiscord } from "./discord"

const NOW = new Date("2026-10-26T14:00:00Z")
const client = { rest: { request: vi.fn() }, guildId: "guild-1" } as unknown as DiscordClient
const input = {
  channelId: "chan-1",
  body: { content: "Weekly digest: 3 things need attention → https://www.longhornsimracing.org/admin", allowed_mentions: { parse: ["everyone" as const] } },
  dedupeKey: "digest:2026-10-26",
  createdById: "officer-gray",
}
const post = (fields: Record<string, unknown>) => ({ id: "post-1", status: "SCHEDULED", discordMessageId: null, ...fields })

beforeEach(() => {
  db.discordPost.updateMany.mockResolvedValue({ count: 1 })
})

describe("sendDigestToDiscord", () => {
  it("queues the day's post as a digest post that pings nobody, and sends it now through Discord posting", async () => {
    outbox.queueDiscordPost.mockResolvedValue({ post: post({}), created: true })
    outbox.sendPostNow.mockResolvedValue({ status: "SENT", messageId: "m-1" })

    expect(await sendDigestToDiscord(input, client, { now: NOW })).toEqual({ status: "sent", messageId: "m-1", postId: "post-1" })
    expect(outbox.queueDiscordPost).toHaveBeenCalledWith({
      source: "digest",
      channelId: "chan-1",
      body: { content: input.body.content, allowed_mentions: { parse: [] } },
      dedupeKey: "digest:2026-10-26",
      scheduledFor: NOW,
      createdById: "officer-gray",
      approvedById: "officer-gray",
    })
    const [id, writer, deps] = outbox.sendPostNow.mock.calls[0]
    expect([id, writer, deps.now()]).toEqual(["post-1", { rest: client.rest, guildId: "guild-1" }, NOW])
    expect(db.discordPost.updateMany).not.toHaveBeenCalled()
  })

  it("sends nothing more once the day's post went out", async () => {
    outbox.queueDiscordPost.mockResolvedValue({ post: post({ status: "SENT", discordMessageId: "m-1" }), created: false })
    expect(await sendDigestToDiscord(input, client, { now: NOW })).toEqual({ status: "already_sent", messageId: "m-1", postId: "post-1" })
    expect(outbox.sendPostNow).not.toHaveBeenCalled()
  })

  it("tries a failed post again with this run's text and channel", async () => {
    outbox.queueDiscordPost.mockResolvedValue({ post: post({ status: "FAILED" }), created: false })
    outbox.sendPostNow.mockResolvedValue({ status: "SENT", messageId: "m-2" })

    expect(await sendDigestToDiscord({ ...input, channelId: "chan-2" }, client, { now: NOW })).toEqual({ status: "sent", messageId: "m-2", postId: "post-1" })
    expect(db.discordPost.updateMany).toHaveBeenCalledWith({
      where: { id: "post-1", status: "FAILED" },
      data: { status: "SCHEDULED", scheduledFor: NOW, channelId: "chan-2", content: { content: input.body.content, allowed_mentions: { parse: [] } }, error: null },
    })
  })

  it("leaves a post another run is sending, one cancelled on Announcements, or one Discord rate-limited, to them", async () => {
    outbox.queueDiscordPost.mockResolvedValue({ post: post({ status: "SENDING" }), created: false })
    for (const outcome of [{ status: "SKIPPED", reason: "It's sending." }, { status: "SCHEDULED", error: "rate limited" }]) {
      outbox.sendPostNow.mockResolvedValueOnce(outcome)
      expect(await sendDigestToDiscord(input, client, { now: NOW })).toEqual({ status: "busy", postId: "post-1" })
    }
  })

  it("throws a failed send to the job (the post keeps the error)", async () => {
    outbox.queueDiscordPost.mockResolvedValue({ post: post({}), created: true })
    outbox.sendPostNow.mockResolvedValue({ status: "FAILED", error: "Discord answered 403 (code 50001 Missing Access)" })
    await expect(sendDigestToDiscord(input, client, { now: NOW })).rejects.toThrow("Discord answered 403 (code 50001 Missing Access)")
  })
})
