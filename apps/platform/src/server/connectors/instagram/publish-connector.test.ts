import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const token = vi.hoisted(() => ({ readPublishAccess: vi.fn(), publishAccount: vi.fn() }))
const state = vi.hoisted(() => ({ connectorEnabled: vi.fn(), readConnectorState: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: {} }))
vi.mock("./publish-token", async (original) => ({ ...(await original<typeof import("./publish-token")>()), ...token }))
vi.mock("@/server/connectors/state", async (original) => ({ ...(await original<typeof import("@/server/connectors/state")>()), ...state }))

import { CLOUDINARY_FAKE, cloudinaryFake } from "../cloudinary/fake/handlers"
import { mountFakes } from "../fakes/testing"
import { INSTAGRAM_FAKE, instagramFake } from "./fake/handlers"
import { INSTAGRAM_PUBLISH_ID, instagramPublishConnector } from "./publish-connector"

const ACCESS = { token: INSTAGRAM_FAKE.publishToken, userId: INSTAGRAM_FAKE.userId, username: "lsr_fake", tokenRefreshedAt: "2026-10-20T12:00:00Z", tokenExpiresAt: "2026-12-19T12:00:00Z" }

beforeEach(() => {
  vi.clearAllMocks()
  token.readPublishAccess.mockResolvedValue(ACCESS)
  token.publishAccount.mockResolvedValue({ connected: true, username: "lsr_fake", tokenExpiresAt: ACCESS.tokenExpiresAt, refreshError: null })
  state.connectorEnabled.mockResolvedValue(false)
  state.readConnectorState.mockResolvedValue(null)
  vi.stubEnv("NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME", CLOUDINARY_FAKE.cloudName)
  vi.stubEnv("CLOUDINARY_API_KEY", CLOUDINARY_FAKE.apiKey)
  vi.stubEnv("CLOUDINARY_API_SECRET", CLOUDINARY_FAKE.apiSecret)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the instagram-publish connector", () => {
  it("is the seeded instagram-publish, set up by Cloudinary's env and the publishing token", async () => {
    expect(instagramPublishConnector).toMatchObject({ id: INSTAGRAM_PUBLISH_ID, label: "Instagram publishing", requiredEnv: ["NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"] })
    expect(INSTAGRAM_PUBLISH_ID).toBe("instagram-publish")
    expect(await instagramPublishConnector.missingSettings!()).toEqual([])
    token.readPublishAccess.mockResolvedValue(null)
    expect(await instagramPublishConnector.missingSettings!()).toEqual(["instagram_publish"])
    vi.stubEnv("CLOUDINARY_API_SECRET", "")
    expect(await instagramPublishConnector.status()).toMatchObject({ state: "not_configured", missingEnv: ["CLOUDINARY_API_SECRET"], missingSettings: ["instagram_publish"] })
  })

  it("gives no client until an admin switches it on, then one that posts as the saved account", async () => {
    expect(await instagramPublishConnector.client()).toBeNull()
    state.connectorEnabled.mockResolvedValue(true)
    const client = await instagramPublishConnector.client()
    expect(client).toMatchObject({ userId: INSTAGRAM_FAKE.userId, username: "lsr_fake" })
    token.readPublishAccess.mockResolvedValue(null)
    expect(await instagramPublishConnector.client()).toBeNull()
  })

  it("has a smoke test that works while switched off and posts nothing: the account, the quota, Cloudinary", async () => {
    const fakes = mountFakes([instagramFake, cloudinaryFake])
    expect(await instagramPublishConnector.smoke!()).toEqual({ ok: true, summary: "Read @lsr_fake: 0 of 50 API posts used in the last 24 hours; Cloudinary answered" })
    expect(fakes.requests.some((r) => r.method === "POST" && r.service === "instagram")).toBe(false)
    vi.stubEnv("CLOUDINARY_API_SECRET", "wrong")
    expect(await instagramPublishConnector.smoke!()).toMatchObject({ ok: false, summary: expect.stringMatching(/Cloudinary answered 401/) })
    token.readPublishAccess.mockResolvedValue(null)
    expect(await instagramPublishConnector.smoke!()).toMatchObject({ ok: false, summary: expect.stringMatching(/^No publishing token is saved/) })
  })

  it("shows the account, the token's renewal and a failed renewal on Connections, never the token", async () => {
    token.publishAccount.mockResolvedValue({ connected: true, username: "lsr_fake", tokenExpiresAt: ACCESS.tokenExpiresAt, refreshError: "Couldn't renew the publishing token: no", refreshErrorAt: "2026-10-21T12:00:00Z" })
    const { details } = await instagramPublishConnector.status()
    expect(details).toEqual([
      { label: "Account", value: "@lsr_fake" },
      { label: "Token", value: "Its own (instagram_publish), renewed weekly by the instagram-publish.token job; runs out Dec 19 if renewing stops" },
      { label: "Renewal", value: "Failed Oct 21: Couldn't renew the publishing token: no" },
    ])
    expect(JSON.stringify(details)).not.toContain(INSTAGRAM_FAKE.publishToken)
  })
})
