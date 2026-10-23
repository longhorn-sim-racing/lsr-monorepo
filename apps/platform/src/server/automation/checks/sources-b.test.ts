import { describe, expect, it, vi } from "vitest"
import type { ConnectorStatus } from "@/server/connectors/types"

const statuses = vi.hoisted(() => ({ twitch: null as unknown, instagram: null as unknown, account: null as unknown }))
vi.mock("@/server/connectors/twitch/connector", () => ({ twitchConnector: { status: async () => statuses.twitch } }))
vi.mock("@/server/connectors/instagram/connector", () => ({ instagramInsightsConnector: { status: async () => statuses.instagram } }))
vi.mock("@/server/connectors/twitch/tokens", () => ({ twitchAccount: async () => statuses.account }))

import { CHECKS, instagramInsightsFailing, twitchNeedsAttention } from "./sources-b"

const ctx = { now: new Date("2026-10-22T18:00:00Z") }
const status = (state: ConnectorStatus["state"], enabled = true): ConnectorStatus => ({ id: "x", label: "X", configured: true, missingEnv: [], missingSettings: [], enabled, state, lastSyncAt: null, lastError: "Twitch answered 401 on /streams: secret stuff", lastErrorAt: "2026-10-22T17:00:00.000Z", hasSmoke: true })
const account = (reconnect: { reason: string; at: string } | null) => ({ connected: true, login: "lsr", scopes: [], connectedAt: null, validatedAt: null, refreshedAt: null, reconnect })

describe("the sources-b checks", () => {
  it("each link to a console page", () => {
    expect(CHECKS.map((c) => [c.id, c.href])).toEqual([["twitch.attention", "/admin/streams"], ["instagram-insights.failing", "/admin/instagram"]])
  })

  it("say nothing while a connection is off, or fine", async () => {
    statuses.twitch = status("error", false)
    statuses.account = account({ reason: "x", at: "2026-10-22T17:00:00.000Z" })
    expect(await twitchNeedsAttention.run(ctx)).toEqual({ count: 0, severity: "info", items: [] })
    statuses.twitch = status("connected")
    statuses.account = account(null)
    expect((await twitchNeedsAttention.run(ctx)).count).toBe(0)
    statuses.instagram = status("connected")
    expect((await instagramInsightsFailing.run(ctx)).count).toBe(0)
  })

  it("flag a Twitch account to reconnect first, then failing syncs, without the error text", async () => {
    statuses.twitch = status("error")
    statuses.account = account({ reason: "Invalid refresh token", at: "2026-10-22T17:00:00.000Z" })
    const reconnect = await twitchNeedsAttention.run(ctx)
    expect(reconnect).toMatchObject({ count: 1, severity: "danger", items: [{ href: "/admin/streams", detail: "Twitch refused its token Oct 22, 12:00 PM CT" }] })
    statuses.account = account(null)
    const failing = await twitchNeedsAttention.run(ctx)
    expect(failing).toMatchObject({ count: 1, severity: "warning", items: [{ title: "Twitch syncs are failing", href: "/admin/connections" }] })
    expect(JSON.stringify([reconnect, failing])).not.toMatch(/secret stuff|Invalid refresh token/)
  })

  it("flag failing Instagram insights", async () => {
    statuses.instagram = status("error")
    expect(await instagramInsightsFailing.run(ctx)).toMatchObject({ count: 1, severity: "warning", items: [{ href: "/admin/instagram", detail: "Since Oct 22, 12:00 PM CT" }] })
  })
})
