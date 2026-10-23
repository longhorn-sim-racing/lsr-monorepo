import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const settings = vi.hoisted(() => new Map<string, string>())
const db = vi.hoisted(() => ({
  systemSetting: {
    findUnique: async ({ where }: { where: { key: string } }) => (settings.has(where.key) ? { key: where.key, value: settings.get(where.key)! } : null),
    upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => settings.set(where.key, create.value),
    deleteMany: async ({ where }: { where: { key: string } }) => ({ count: Number(settings.delete(where.key)) }),
    updateMany: async ({ where, data }: { where: { key: string; value: string }; data: { value: string } }) => {
      if (settings.get(where.key) !== where.value) return { count: 0 }
      settings.set(where.key, data.value)
      return { count: 1 }
    },
  },
}))
vi.mock("@/server/db", () => ({ prisma: db }))

import { mountFakes } from "../fakes/testing"
import { INSTAGRAM_FAKE, instagramFake } from "./fake/handlers"
import { forgetPublishToken, publishAccount, PUBLISH_SETTING, readPublishAccess, refreshPublishToken, savePublishToken } from "./publish-token"

const NOW = new Date("2026-10-22T17:00:00Z")
const DAY = 86_400_000
const stored = () => JSON.parse(settings.get(PUBLISH_SETTING) ?? "{}")

beforeEach(() => {
  settings.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the publishing token", () => {
  it("is kept in SystemSetting instagram_publish, apart from the feed's, and never shown to pages", async () => {
    expect(await readPublishAccess()).toBeNull()
    expect(await publishAccount()).toEqual({ connected: false })
    await savePublishToken({ token: INSTAGRAM_FAKE.publishToken, userId: INSTAGRAM_FAKE.userId, username: "lsr_fake", connectedById: "admin-1", now: NOW })
    expect(settings.has("instagram")).toBe(false)
    expect(await readPublishAccess()).toEqual({ token: INSTAGRAM_FAKE.publishToken, userId: INSTAGRAM_FAKE.userId, username: "lsr_fake", tokenRefreshedAt: NOW.toISOString(), tokenExpiresAt: new Date(NOW.getTime() + 60 * DAY).toISOString() })
    const account = await publishAccount()
    expect(account).toMatchObject({ connected: true, username: "lsr_fake", connectedById: "admin-1" })
    expect(JSON.stringify(account)).not.toContain(INSTAGRAM_FAKE.publishToken)
    await forgetPublishToken()
    expect(await readPublishAccess()).toBeNull()
  })

  it("is renewed once it's 6 days old, through Instagram's refresh, and the new one stored", async () => {
    mountFakes([instagramFake])
    await savePublishToken({ token: INSTAGRAM_FAKE.publishToken, userId: INSTAGRAM_FAKE.userId, username: "lsr_fake", connectedById: "admin-1", now: NOW })
    expect(await refreshPublishToken({ now: new Date(NOW.getTime() + 5 * DAY) })).toEqual({ status: "not-due", refreshedAt: NOW.toISOString() })

    const later = new Date(NOW.getTime() + 7 * DAY)
    const outcome = await refreshPublishToken({ now: later })
    expect(outcome).toEqual({ status: "refreshed", expiresAt: new Date(later.getTime() + 5_184_000_000).toISOString() })
    expect(stored()).toMatchObject({ token: "IGfake-refreshed-1", tokenRefreshedAt: later.toISOString(), refreshError: null })
  })

  it("keeps a token an admin pasted while a renewal ran", async () => {
    mountFakes([instagramFake])
    await savePublishToken({ token: INSTAGRAM_FAKE.publishToken, userId: INSTAGRAM_FAKE.userId, username: "lsr_fake", connectedById: "admin-1", now: NOW })
    const original = db.systemSetting.updateMany
    db.systemSetting.updateMany = async (args: Parameters<typeof original>[0]) => {
      // The paste lands between the renewal's read and its write
      settings.set(PUBLISH_SETTING, JSON.stringify({ ...stored(), token: "IGfake-pasted-meanwhile" }))
      return original(args)
    }
    try {
      expect(await refreshPublishToken({ now: new Date(NOW.getTime() + 7 * DAY) })).toEqual({ status: "replaced" })
    } finally {
      db.systemSetting.updateMany = original
    }
    expect(stored().token).toBe("IGfake-pasted-meanwhile")
  })

  it("records why a renewal failed (redacted), for the pages and the digest, and throws", async () => {
    mountFakes([instagramFake])
    await savePublishToken({ token: INSTAGRAM_FAKE.publishToken, userId: INSTAGRAM_FAKE.userId, username: "lsr_fake", connectedById: "admin-1", now: NOW })
    await fetch("http://127.0.0.1:3999/instagram/_fake/state", { method: "POST", body: JSON.stringify({ expire: true }) })
    await expect(refreshPublishToken({ now: new Date(NOW.getTime() + 7 * DAY) })).rejects.toThrow(/expired or was revoked: an admin pastes a new one/)
    expect(stored()).toMatchObject({ token: INSTAGRAM_FAKE.publishToken, refreshError: expect.stringMatching(/expired or was revoked/), refreshErrorAt: expect.any(String) })
    expect(stored().refreshError).not.toContain(INSTAGRAM_FAKE.publishToken)
  })

  it("does nothing without a token", async () => {
    expect(await refreshPublishToken({ now: NOW })).toEqual({ status: "none" })
  })
})
