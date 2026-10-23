import { Prisma } from "@prisma/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ discordPost: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() } }))
vi.mock("@/server/db", () => ({ prisma: db }))

import { discordClient } from "@/server/connectors/discord/client"
import { DiscordRateLimiter } from "@/server/connectors/discord/rate-limit"
import { mountFakes } from "@/server/connectors/fakes/testing"
import type { FakeService } from "@/server/connectors/fakes/types"
import { SENDING_STALE_MS, sendDigestToDiscord } from "./discord"

/**
 * Discord's Create Message, as research/discord.md describes it: until discord-post extends the shared
 * Discord fake with its write routes, this test-only fake answers it. A repeated nonce with
 * enforce_nonce returns the message it already made instead of posting another.
 */
function createMessageFake(state: { posted: { channelId: string; body: Record<string, unknown> }[]; fail?: number }): FakeService {
  return {
    id: "discord",
    create: () => {
      const byNonce = new Map<string, { id: string }>()
      return [
        {
          method: "POST",
          path: "/api/v10/channels/:channelId/messages",
          async handle(request, { params }) {
            if (request.headers.get("authorization") !== `Bot ${TOKEN}`) return Response.json({ message: "401: Unauthorized", code: 0 }, { status: 401 })
            if (state.fail) return Response.json({ message: "Missing Access", code: 50001 }, { status: state.fail })
            const body = (await request.json()) as Record<string, unknown>
            const nonce = typeof body.nonce === "string" ? body.nonce : null
            if (nonce && body.enforce_nonce && byNonce.has(nonce)) return Response.json(byNonce.get(nonce))
            const message = { id: `13000000000000000${String(state.posted.length).padStart(2, "0")}` }
            if (nonce) byNonce.set(nonce, message)
            state.posted.push({ channelId: params.channelId, body })
            return Response.json(message)
          },
        },
      ]
    },
  }
}

const TOKEN = "fake-bot-" + "token-for-tests"
const NOW = new Date("2026-10-26T14:00:00Z")
const CHANNEL = "1100000000000000020"
const body = { content: "**LSR weekly digest** · Mon, Oct 26", allowed_mentions: { parse: [] as string[] }, flags: 4 }
const input = { channelId: CHANNEL, body, dedupeKey: "digest:2026-10-26", createdById: "gray" }
const client = () => discordClient({ token: TOKEN, guildId: "1100000000000000000", limiter: new DiscordRateLimiter() })
const unique = () => new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`dedupeKey`)", { code: "P2002", clientVersion: "6.15.0" })

let state: { posted: { channelId: string; body: Record<string, unknown> }[]; fail?: number }

beforeEach(() => {
  state = { posted: [] }
  db.discordPost.create.mockImplementation(async ({ data }) => ({ id: "post-1", nonce: data.nonce }))
  db.discordPost.updateMany.mockResolvedValue({ count: 1 })
  db.discordPost.update.mockResolvedValue({})
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("posting the digest to Discord", () => {
  it("claims the day's row as SENDING, posts with every ping off and a nonce Discord enforces, then marks it SENT", async () => {
    mountFakes([createMessageFake(state)])
    const result = await sendDigestToDiscord(input, client(), { now: NOW })
    expect(result).toEqual({ status: "sent", messageId: "1300000000000000000", postId: "post-1" })
    const created = db.discordPost.create.mock.calls[0][0].data
    expect(created).toMatchObject({ source: "digest", channelId: CHANNEL, content: body, dedupeKey: "digest:2026-10-26", status: "SENDING", scheduledFor: NOW, claimedAt: NOW, createdById: "gray", approvedById: "gray" })
    expect(created.nonce.length).toBeLessThanOrEqual(25)
    expect(state.posted).toEqual([{ channelId: CHANNEL, body: { ...body, allowed_mentions: { parse: [] }, nonce: created.nonce, enforce_nonce: true } }])
    expect(db.discordPost.update).toHaveBeenCalledWith({ where: { id: "post-1" }, data: expect.objectContaining({ status: "SENT", discordMessageId: "1300000000000000000", error: null }) })
  })

  it("sends nothing more once the day's post went out", async () => {
    mountFakes([createMessageFake(state)])
    db.discordPost.create.mockRejectedValue(unique())
    db.discordPost.findUnique.mockResolvedValue({ id: "post-1", status: "SENT", nonce: "n1", discordMessageId: "m1" })
    expect(await sendDigestToDiscord(input, client(), { now: NOW })).toEqual({ status: "already_sent", messageId: "m1", postId: "post-1" })
    expect(state.posted).toHaveLength(0)
  })

  it("leaves a post another run is sending alone, and only takes over a failed one or a stale claim", async () => {
    mountFakes([createMessageFake(state)])
    db.discordPost.create.mockRejectedValue(unique())
    db.discordPost.findUnique.mockResolvedValue({ id: "post-1", status: "SENDING", nonce: "n1", discordMessageId: null })
    db.discordPost.updateMany.mockResolvedValue({ count: 0 })
    expect(await sendDigestToDiscord(input, client(), { now: NOW })).toEqual({ status: "busy", postId: "post-1" })
    expect(db.discordPost.updateMany.mock.calls[0][0].where).toEqual({
      id: "post-1",
      OR: [{ status: { in: ["SCHEDULED", "FAILED"] } }, { status: "SENDING", claimedAt: { lt: new Date(NOW.getTime() - SENDING_STALE_MS) } }],
    })
    expect(state.posted).toHaveLength(0)
  })

  it("retries a failed post with its own nonce, so a post Discord already made isn't made twice", async () => {
    mountFakes([createMessageFake(state)])
    const discord = client()
    // The first try reached Discord, but its answer was lost: the row says FAILED
    await sendDigestToDiscord(input, discord, { now: NOW })
    const nonce = db.discordPost.create.mock.calls[0][0].data.nonce
    db.discordPost.create.mockRejectedValue(unique())
    db.discordPost.findUnique.mockResolvedValue({ id: "post-1", status: "FAILED", nonce, discordMessageId: null })
    const retried = await sendDigestToDiscord(input, discord, { now: NOW })
    expect(retried).toMatchObject({ status: "sent", messageId: "1300000000000000000" })
    expect(state.posted).toHaveLength(1)
    expect(db.discordPost.updateMany.mock.calls[0][0].data).toMatchObject({ status: "SENDING", nonce, error: null })
  })

  it("records a failure on the row, redacted, and throws it to the job", async () => {
    mountFakes([createMessageFake(state)])
    state.fail = 403
    await expect(sendDigestToDiscord(input, client(), { now: NOW })).rejects.toThrow(/Discord answered 403 \(code 50001 Missing Access\)/)
    expect(db.discordPost.update).toHaveBeenCalledWith({ where: { id: "post-1" }, data: { status: "FAILED", error: expect.stringMatching(/403/) } })
    expect(JSON.stringify(db.discordPost.update.mock.calls)).not.toContain(TOKEN)
  })
})
