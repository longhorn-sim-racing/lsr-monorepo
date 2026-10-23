import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ instagramPublish: { count: vi.fn() } }))
const connector = vi.hoisted(() => ({ client: vi.fn() }))
const state = vi.hoisted(() => ({ recordConnectorSync: vi.fn(), recordConnectorError: vi.fn() }))
const token = vi.hoisted(() => ({ refreshPublishToken: vi.fn() }))
const flow = vi.hoisted(() => ({ finishInstagramPublishes: vi.fn(), publishDeps: vi.fn((client: unknown) => ({ client })) }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/connectors/instagram/publish-connector", () => ({ INSTAGRAM_PUBLISH_ID: "instagram-publish", instagramPublishConnector: connector }))
vi.mock("@/server/connectors/state", () => state)
vi.mock("@/server/connectors/instagram/publish-token", () => token)
vi.mock("./instagram", () => flow)

import { JOBS } from "@/server/scheduler/jobs/decks-rooms"
import { runInstagramPublishFinish, runInstagramPublishToken } from "./jobs"

const ctx = { signal: new AbortController().signal, deadline: Date.now() + 90_000, log: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  db.instagramPublish.count.mockResolvedValue(2)
  connector.client.mockResolvedValue({ username: "lsr_fake" })
})

describe("instagram-publish.finish", () => {
  it("does nothing while no post waits, and is skipped while publishing is off", async () => {
    db.instagramPublish.count.mockResolvedValue(0)
    expect(await runInstagramPublishFinish(ctx)).toEqual({ summary: "No posts waiting on Instagram" })
    expect(connector.client).not.toHaveBeenCalled()

    db.instagramPublish.count.mockResolvedValue(2)
    connector.client.mockResolvedValue(null)
    expect(await runInstagramPublishFinish(ctx)).toMatchObject({ status: "skipped", summary: expect.stringMatching(/^2 posts waiting, but Instagram publishing isn't connected/) })
    expect(flow.finishInstagramPublishes).not.toHaveBeenCalled()
  })

  it("moves waiting posts along and stamps the connector", async () => {
    flow.finishInstagramPublishes.mockResolvedValue({ published: 1, failed: 1, waiting: 1, busy: 0, errors: [] })
    expect(await runInstagramPublishFinish(ctx)).toEqual({ summary: "1 post went up; 1 post failed; 1 post still processing", counts: { published: 1, failed: 1, waiting: 1, busy: 0, errors: 0 } })
    expect(flow.finishInstagramPublishes).toHaveBeenCalledWith({ client: { username: "lsr_fake" } }, { deadline: ctx.deadline, signal: ctx.signal })
    expect(state.recordConnectorSync).toHaveBeenCalledWith("instagram-publish")
  })

  it("records a check that failed on the connector, and says the next run tries again", async () => {
    flow.finishInstagramPublishes.mockResolvedValue({ published: 0, failed: 0, waiting: 2, busy: 0, errors: ["Instagram answered 400 (code 190)"] })
    await runInstagramPublishFinish(ctx)
    expect(state.recordConnectorError).toHaveBeenCalledWith("instagram-publish", new Error("Instagram answered 400 (code 190)"))
    expect(ctx.log).toHaveBeenCalledWith("Couldn't check 1 post with Instagram; the next run tries again.")
  })
})

describe("instagram-publish.token", () => {
  it("renews the token, and is skipped while publishing is off", async () => {
    token.refreshPublishToken.mockResolvedValue({ status: "refreshed", expiresAt: "2026-12-21T05:15:00.000Z" })
    expect(await runInstagramPublishToken()).toEqual({ summary: "Renewed the publishing token; it now runs out 2026-12-21" })
    expect(state.recordConnectorSync).toHaveBeenCalledWith("instagram-publish")
    token.refreshPublishToken.mockResolvedValue({ status: "not-due", refreshedAt: "x" })
    expect(await runInstagramPublishToken()).toEqual({ summary: "The publishing token was renewed less than 6 days ago" })
    connector.client.mockResolvedValue(null)
    expect(await runInstagramPublishToken()).toMatchObject({ status: "skipped" })
  })

  it("fails the run and the connector when Instagram refuses", async () => {
    token.refreshPublishToken.mockRejectedValue(new Error("Instagram says the publishing token has expired"))
    await expect(runInstagramPublishToken()).rejects.toThrow("expired")
    expect(state.recordConnectorError).toHaveBeenCalledWith("instagram-publish", expect.any(Error))
  })
})

describe("the decks-rooms job kinds", () => {
  it("are the follow-up every 5 minutes and the weekly renewal, both inline", () => {
    expect(JOBS.map((job) => [job.kind, job.defaultSchedule, job.budgetMs, job.handoff ?? false])).toEqual([
      ["instagram-publish.finish", "*/5 * * * *", 90_000, false],
      ["instagram-publish.token", "15 5 * * 1", 30_000, false],
    ])
  })
})
