import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ userRole: { count: vi.fn() }, instagramPublish: { findUnique: vi.fn() } }))
const guards = vi.hoisted(() => ({ requireOfficer: vi.fn() }))
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }))
const token = vi.hoisted(() => ({ savePublishToken: vi.fn(), forgetPublishToken: vi.fn(), publishAccount: vi.fn() }))
const feed = vi.hoisted(() => ({ readInstagramAccess: vi.fn() }))
const connector = vi.hoisted(() => ({ client: vi.fn() }))
const flow = vi.hoisted(() => ({ finishInstagramPublishes: vi.fn(), publishDeps: vi.fn((client: unknown) => ({ client })) }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/auth/guards", () => guards)
vi.mock("@/server/audit/log", () => audit)
vi.mock("next/cache", () => cache)
vi.mock("@/server/connectors/instagram/publish-token", () => token)
vi.mock("@/server/services/instagram.service", () => feed)
vi.mock("@/server/connectors/instagram/publish-connector", () => ({ INSTAGRAM_PUBLISH_ID: "instagram-publish", instagramPublishConnector: connector }))
vi.mock("@/server/jack/publish/instagram", () => flow)

import { mountFakes } from "@/server/connectors/fakes/testing"
import { INSTAGRAM_FAKE, instagramFake } from "@/server/connectors/instagram/fake/handlers"
import { checkInstagramPublishNow, connectInstagramPublishing, disconnectInstagramPublishing } from "./publish-actions"

const asAdmin = () => db.userRole.count.mockResolvedValue(1)
const asOfficer = () => db.userRole.count.mockResolvedValue(0)

beforeEach(() => {
  vi.clearAllMocks()
  guards.requireOfficer.mockResolvedValue({ id: "u1", displayName: "Gray" })
  feed.readInstagramAccess.mockResolvedValue({ token: INSTAGRAM_FAKE.token, userId: INSTAGRAM_FAKE.userId, username: "lsr_fake" })
  token.publishAccount.mockResolvedValue({ connected: true, username: "lsr_fake" })
  mountFakes([instagramFake])
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("connecting Instagram publishing", () => {
  it("is for admins only", async () => {
    asOfficer()
    expect(await connectInstagramPublishing(INSTAGRAM_FAKE.publishToken)).toEqual({ ok: false, error: "Only admins can connect or disconnect Instagram publishing." })
    expect(await disconnectInstagramPublishing()).toEqual({ ok: false, error: "Only admins can connect or disconnect Instagram publishing." })
    expect(token.savePublishToken).not.toHaveBeenCalled()
    expect(token.forgetPublishToken).not.toHaveBeenCalled()
  })

  it("checks the token with Instagram, stores it and audits the account, never the token", async () => {
    asAdmin()
    expect(await connectInstagramPublishing(`  ${INSTAGRAM_FAKE.publishToken}  `)).toEqual({ ok: true, data: { username: INSTAGRAM_FAKE.username } })
    expect(token.savePublishToken).toHaveBeenCalledWith({ token: INSTAGRAM_FAKE.publishToken, userId: INSTAGRAM_FAKE.userId, username: INSTAGRAM_FAKE.username, connectedById: "u1" })
    expect(audit.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: "u1", actionType: "CONNECT", entityType: "CONNECTOR", entityId: "instagram-publish" }))
    expect(JSON.stringify(audit.createAuditLog.mock.calls)).not.toContain(INSTAGRAM_FAKE.publishToken)
    expect(cache.revalidatePath).toHaveBeenCalledWith("/admin/instagram")
  })

  it("refuses the feed's own token, a token that can't publish, a dead one, and another account's", async () => {
    asAdmin()
    expect(await connectInstagramPublishing(INSTAGRAM_FAKE.token)).toMatchObject({ ok: false, error: expect.stringMatching(/^That's the feed's own token/) })
    feed.readInstagramAccess.mockResolvedValue(null)
    expect(await connectInstagramPublishing(INSTAGRAM_FAKE.basicToken)).toMatchObject({ ok: false, error: expect.stringMatching(/^That token can't publish: generate it with instagram_business_content_publish/) })
    expect(await connectInstagramPublishing("IGfake-not-a-real-token-at-all")).toMatchObject({ ok: false, error: expect.stringMatching(/expired or revoked/) })
    expect(await connectInstagramPublishing("short")).toEqual({ ok: false, error: "Paste the whole token" })
    feed.readInstagramAccess.mockResolvedValue({ token: "other", userId: "17840000000000099", username: "someone_else" })
    expect(await connectInstagramPublishing(INSTAGRAM_FAKE.publishToken)).toMatchObject({ ok: false, error: `That token is for @${INSTAGRAM_FAKE.username}, but the club's feed is @someone_else. Generate it signed in as the club account.` })
    expect(token.savePublishToken).not.toHaveBeenCalled()
  })

  it("disconnects, audited", async () => {
    asAdmin()
    expect(await disconnectInstagramPublishing()).toEqual({ ok: true })
    expect(token.forgetPublishToken).toHaveBeenCalled()
    expect(audit.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ actionType: "DISCONNECT", entityId: "instagram-publish", summary: "Disconnected Instagram publishing (@lsr_fake)" }))
  })
})

describe("checking a waiting post now", () => {
  const ID = "33333333-3333-4333-8333-333333333333"

  it("lets any officer run the follow-up on one post", async () => {
    connector.client.mockResolvedValue({ username: "lsr_fake" })
    flow.finishInstagramPublishes.mockResolvedValue({ published: 1, failed: 0, waiting: 0, busy: 0, errors: [] })
    db.instagramPublish.findUnique.mockResolvedValue({ status: "published" })
    expect(await checkInstagramPublishNow(ID)).toEqual({ ok: true, data: { status: "published" } })
    expect(flow.finishInstagramPublishes).toHaveBeenCalledWith({ client: { username: "lsr_fake" } }, expect.objectContaining({ ids: [ID] }))
  })

  it("says when it can't: a bad id, publishing off, someone else on it, Instagram not answering", async () => {
    expect(await checkInstagramPublishNow("nope")).toMatchObject({ ok: false })
    connector.client.mockResolvedValue(null)
    expect(await checkInstagramPublishNow(ID)).toMatchObject({ ok: false, error: expect.stringMatching(/isn't connected/) })
    connector.client.mockResolvedValue({})
    flow.finishInstagramPublishes.mockResolvedValue({ published: 0, failed: 0, waiting: 0, busy: 1, errors: [] })
    expect(await checkInstagramPublishNow(ID)).toMatchObject({ ok: false, error: expect.stringMatching(/being handled right now/) })
    flow.finishInstagramPublishes.mockResolvedValue({ published: 0, failed: 0, waiting: 1, busy: 0, errors: ["fetch failed"] })
    expect(await checkInstagramPublishNow(ID)).toEqual({ ok: false, error: "Instagram didn't answer the check: fetch failed" })
  })
})
