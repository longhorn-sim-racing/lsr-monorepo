import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  scheduledJob: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  jackRoom: { findUnique: vi.fn() },
}))
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))
const channels = vi.hoisted(() => ({ postingChannels: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/audit/log", () => audit)
vi.mock("@/server/discord-post/channels", () => channels)

import type { DigestSettingsInput } from "@/lib/jack/recurring"
import { loadDigestJob, saveDigestSettings } from "./settings"

const NOW = new Date("2026-10-22T17:00:00Z") // Thu, noon Central
const job = (overrides: Record<string, unknown> = {}) => ({
  id: "job-d",
  key: "digest.weekly",
  kind: "digest.weekly",
  schedule: "0 9 * * 1",
  enabled: false,
  config: null,
  nextRunAt: new Date("2026-10-26T14:00:00Z"),
  ...overrides,
})
const input = (overrides: Partial<DigestSettingsInput> = {}): DigestSettingsInput => ({ enabled: true, roomId: "room-1", day: "fri", time: "16:30", summary: true, discordChannelId: "", teams: false, ...overrides })
const officer = { userId: "dylan", isAdmin: false }
const admin = { userId: "gray", isAdmin: true }

beforeEach(() => {
  db.scheduledJob.findUnique.mockResolvedValue(job())
  db.scheduledJob.update.mockResolvedValue(job())
  db.jackRoom.findUnique.mockResolvedValue({ archivedAt: null })
  channels.postingChannels.mockResolvedValue([{ id: "1100000000000000020", name: "officers", type: 0 }])
})

describe("the digest's settings", () => {
  it("reads its day and time from the job's schedule, and makes the row (off) when it's missing", async () => {
    expect(await loadDigestJob(NOW)).toMatchObject({ day: "mon", time: "09:00", config: { roomId: null, summary: true, teams: false } })
    db.scheduledJob.findUnique.mockResolvedValue(null)
    db.scheduledJob.upsert.mockResolvedValue(job({ schedule: "30 16 * * 5" }))
    expect(await loadDigestJob(NOW)).toMatchObject({ day: "fri", time: "16:30" })
    expect(db.scheduledJob.upsert.mock.calls[0][0].create).toMatchObject({ key: "digest.weekly", kind: "digest.weekly", schedule: "0 9 * * 1", enabled: false })
  })

  it("lets any officer set the room, day, time and summary and turn it on, recording who did", async () => {
    expect(await saveDigestSettings(input(), officer, NOW)).toEqual({ ok: true, changed: ["roomId", "schedule", "enabled"] })
    const data = db.scheduledJob.update.mock.calls[0][0].data
    expect(data).toMatchObject({ schedule: "30 16 * * 5", enabled: true, updatedById: "dylan", nextRunAt: new Date("2026-10-23T21:30:00Z") })
    expect(data.config).toEqual({ roomId: "room-1", summary: true, discordChannelId: null, teams: false, configuredById: "dylan", configuredAt: NOW.toISOString() })
    expect(audit.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: "dylan", actionType: "DIGEST_CONFIGURED", entityType: "SCHEDULED_JOB", entityId: "job-d" }))
  })

  it("keeps Discord and Teams an admin's call", async () => {
    expect(await saveDigestSettings(input({ teams: true }), officer, NOW)).toEqual({ ok: false, error: expect.stringMatching(/Only admins/) })
    expect(await saveDigestSettings(input({ discordChannelId: "1100000000000000020" }), officer, NOW)).toEqual({ ok: false, error: expect.stringMatching(/Only admins/) })
    expect(db.scheduledJob.update).not.toHaveBeenCalled()
    expect(await saveDigestSettings(input({ discordChannelId: "1100000000000000020", teams: true }), admin, NOW)).toMatchObject({ ok: true })
    expect(db.scheduledJob.update.mock.calls[0][0].data.config).toMatchObject({ discordChannelId: "1100000000000000020", teams: true, configuredById: "gray" })
  })

  it("lets an officer save the rest while an admin's Discord and Teams settings stay as they are", async () => {
    db.scheduledJob.findUnique.mockResolvedValue(job({ config: { roomId: "room-1", summary: true, discordChannelId: "1100000000000000020", teams: true, configuredById: "gray", configuredAt: null } }))
    expect(await saveDigestSettings(input({ discordChannelId: "1100000000000000020", teams: true, summary: false }), officer, NOW)).toMatchObject({ ok: true })
    // Even once its channel stopped being a posting channel (the run refuses to post there)
    channels.postingChannels.mockResolvedValue([])
    expect(await saveDigestSettings(input({ discordChannelId: "1100000000000000020", teams: true }), officer, NOW)).toMatchObject({ ok: true })
  })

  it("needs a room to turn it on, and refuses archived rooms and Discord channels that aren't posting channels", async () => {
    expect(await saveDigestSettings(input({ roomId: "" }), officer, NOW)).toEqual({ ok: false, error: expect.stringMatching(/Pick the room/) })
    db.jackRoom.findUnique.mockResolvedValueOnce({ archivedAt: NOW })
    expect(await saveDigestSettings(input(), officer, NOW)).toEqual({ ok: false, error: expect.stringMatching(/archived/) })
    // A text channel the sync knows isn't enough: it must be one an admin allows posting in, like every post
    expect(await saveDigestSettings(input({ discordChannelId: "1100000000000000030" }), admin, NOW)).toEqual({ ok: false, error: expect.stringMatching(/Pick one of the Discord posting channels/) })
    channels.postingChannels.mockResolvedValueOnce([])
    expect(await saveDigestSettings(input({ discordChannelId: "1100000000000000020" }), admin, NOW)).toEqual({ ok: false, error: expect.stringMatching(/posting channels/) })
    expect(db.scheduledJob.update).not.toHaveBeenCalled()
    expect(await saveDigestSettings(input({ time: "4pm" }), officer, NOW)).toEqual({ ok: false, error: expect.stringMatching(/HH:MM/) })
    // Off, it can be saved without a room
    expect(await saveDigestSettings(input({ enabled: false, roomId: "" }), officer, NOW)).toMatchObject({ ok: true })
  })

  it("keeps the next run when nothing about when it runs changed", async () => {
    db.scheduledJob.findUnique.mockResolvedValue(job({ enabled: true, schedule: "30 16 * * 5", nextRunAt: new Date("2026-10-23T21:30:00Z") }))
    await saveDigestSettings(input({ summary: false }), officer, NOW)
    expect(db.scheduledJob.update.mock.calls[0][0].data.nextRunAt).toEqual(new Date("2026-10-23T21:30:00Z"))
  })
})
