import { beforeEach, describe, expect, it, vi } from "vitest"

// vitest.config resets mocks before each test, so their results are set in beforeEach
const mocks = vi.hoisted(() => ({
  findEvents: vi.fn(),
  processScheduled: vi.fn(),
  processStuck: vi.fn(),
  failInterrupted: vi.fn(),
  syncInstagram: vi.fn(),
  sweep: vi.fn(),
}))
vi.mock("@/server/db", () => ({ prisma: { event: { findMany: mocks.findEvents } } }))
vi.mock("@/server/services/notification.service", () => ({
  processScheduledNotifications: mocks.processScheduled,
  processStuckNotifications: mocks.processStuck,
  failInterruptedEmails: mocks.failInterrupted,
  sendNotification: vi.fn(),
}))
vi.mock("@/server/services/instagram.service", () => ({ syncInstagram: mocks.syncInstagram }))
vi.mock("@/server/services/recruiting-email.service", () => ({ sweepAndNotify: mocks.sweep }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

const routes = {
  notifications: () => import("./notifications/route"),
  instagram: () => import("./instagram/route"),
  recruiting: () => import("./recruiting/route"),
}

function request(authorization?: string) {
  return new Request("http://localhost/api/cron/x", { headers: authorization ? { Authorization: authorization } : {} })
}

describe.each(Object.entries(routes))("/api/cron/%s", (_name, load) => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production")
    mocks.findEvents.mockResolvedValue([])
    mocks.processScheduled.mockResolvedValue(0)
    mocks.processStuck.mockResolvedValue(0)
    mocks.failInterrupted.mockResolvedValue(0)
    mocks.syncInstagram.mockResolvedValue({ ok: true, added: 0, updated: 0, removed: 0 })
    mocks.sweep.mockResolvedValue({ failed: 0, timedOut: false })
  })

  it("refuses every request when CRON_SECRET isn't set, even one that sends 'Bearer undefined'", async () => {
    vi.stubEnv("CRON_SECRET", "")
    const { GET } = await load()
    expect((await GET(request("Bearer undefined"))).status).toBe(401)
    expect((await GET(request())).status).toBe(401)
  })

  it("refuses a wrong secret, outside production too", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret")
    vi.stubEnv("NODE_ENV", "development")
    const { GET } = await load()
    expect((await GET(request("Bearer wrong"))).status).toBe(401)
    expect((await GET(request())).status).toBe(401)
  })

  it("runs with the right secret", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret")
    const { GET } = await load()
    expect((await GET(request("Bearer s3cret"))).status).toBe(200)
  })
})
