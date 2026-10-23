import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AnyConnector } from "@/server/connectors/types"

const db = vi.hoisted(() => ({ userRole: { count: vi.fn() } }))
const state = vi.hoisted(() => ({ readConnectorState: vi.fn(), setConnectorEnabled: vi.fn(), CONNECTOR_ENTITY: "CONNECTOR" }))
const registry = vi.hoisted(() => ({ connectors: [] as AnyConnector[] }))
const smoke = vi.hoisted(() => ({ runConnectorSmoke: vi.fn(), SMOKE_ACTION: "SMOKE_TEST" }))
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }))
const guards = vi.hoisted(() => ({ requireOfficer: vi.fn() }))

vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/auth/guards", () => guards)
vi.mock("@/server/audit/log", () => audit)
vi.mock("next/cache", () => cache)
vi.mock("@/server/connectors/state", () => state)
vi.mock("@/server/connectors/status", () => smoke)
vi.mock("@/server/connectors/registry", () => ({ findConnector: (id: string) => registry.connectors.find((c) => c.id === id) }))

import { runConnectorSmokeAction, setConnectorEnabledAction } from "./actions"

function connector(id: string, overrides: Partial<AnyConnector> = {}): AnyConnector {
  return {
    id,
    label: "Discord",
    requiredEnv: ["DISCORD_BOT_TOKEN"],
    configured: (env) => Boolean(env.DISCORD_BOT_TOKEN),
    enabled: async () => false,
    client: async () => null,
    status: async () => {
      throw new Error("unused")
    },
    ...overrides,
  }
}

const asAdmin = () => db.userRole.count.mockResolvedValue(1)
const asOfficer = () => db.userRole.count.mockResolvedValue(0)

beforeEach(() => {
  guards.requireOfficer.mockResolvedValue({ id: "user-1" })
  asAdmin()
  registry.connectors = [connector("discord", { smoke: async () => ({ ok: true, summary: "ok" }) })]
  state.readConnectorState.mockResolvedValue(null)
  state.setConnectorEnabled.mockResolvedValue({ changed: true })
  smoke.runConnectorSmoke.mockResolvedValue({ ok: true, summary: "Read 6 channels", ms: 210 })
  vi.stubEnv("DISCORD_BOT_TOKEN", "set")
})

describe("setConnectorEnabledAction", () => {
  it("is admin-only: an officer gets a message and nothing changes", async () => {
    asOfficer()
    expect(await setConnectorEnabledAction("discord", true)).toEqual({ ok: false, error: expect.stringMatching(/Only admins/) })
    expect(db.userRole.count).toHaveBeenCalledWith({ where: { userId: "user-1", role: { key: "admin" } } })
    expect(state.setConnectorEnabled).not.toHaveBeenCalled()
    expect(cache.revalidatePath).not.toHaveBeenCalled()
  })

  it("throws for someone who isn't an officer, like every admin action", async () => {
    guards.requireOfficer.mockRejectedValue(new Error("Requires one of the following roles: admin, officer"))
    await expect(setConnectorEnabledAction("discord", true)).rejects.toThrow(/roles/)
    expect(state.setConnectorEnabled).not.toHaveBeenCalled()
  })

  it("lets an admin switch a set-up connector on, as themselves", async () => {
    expect(await setConnectorEnabledAction("discord", true)).toEqual({ ok: true, data: { changed: true } })
    expect(state.setConnectorEnabled).toHaveBeenCalledWith("discord", true, { userId: "user-1", label: "Discord" })
    expect(cache.revalidatePath).toHaveBeenCalledWith("/admin/connections")
  })

  it("won't switch on a connector that's missing env or settings, but always switches one off", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "")
    expect(await setConnectorEnabledAction("discord", true)).toEqual({ ok: false, error: "Set it up first. Missing: DISCORD_BOT_TOKEN" })

    vi.stubEnv("DISCORD_BOT_TOKEN", "set")
    registry.connectors = [connector("discord", { missingSettings: async () => ["discord_oauth"] })]
    expect(await setConnectorEnabledAction("discord", true)).toEqual({ ok: false, error: "Set it up first. Missing: discord_oauth" })
    expect(state.setConnectorEnabled).not.toHaveBeenCalled()

    vi.stubEnv("DISCORD_BOT_TOKEN", "")
    expect(await setConnectorEnabledAction("discord", false)).toMatchObject({ ok: true })
    expect(state.setConnectorEnabled).toHaveBeenCalledWith("discord", false, expect.anything())
  })

  it("switches a planned connector without code off, never on", async () => {
    state.readConnectorState.mockResolvedValue({ id: "teams", enabled: true })
    expect(await setConnectorEnabledAction("teams", true)).toEqual({ ok: false, error: expect.stringMatching(/isn't built yet/) })
    expect(await setConnectorEnabledAction("teams", false)).toMatchObject({ ok: true })
    expect(state.setConnectorEnabled).toHaveBeenCalledWith("teams", false, { userId: "user-1", label: undefined })
  })

  it("refuses unknown and malformed ids", async () => {
    expect(await setConnectorEnabledAction("nope", false)).toEqual({ ok: false, error: expect.stringMatching(/no connection called that/) })
    expect(await setConnectorEnabledAction("../../etc", false)).toEqual({ ok: false, error: expect.stringMatching(/no connection called that/) })
    expect(await setConnectorEnabledAction("discord", "yes" as unknown as boolean)).toEqual({ ok: false, error: expect.stringMatching(/no connection called that/) })
    expect(state.setConnectorEnabled).not.toHaveBeenCalled()
  })
})

describe("runConnectorSmokeAction", () => {
  it("is admin-only", async () => {
    asOfficer()
    expect(await runConnectorSmokeAction("discord")).toEqual({ ok: false, error: expect.stringMatching(/Only admins/) })
    expect(smoke.runConnectorSmoke).not.toHaveBeenCalled()
  })

  it("runs the test and records the outcome in the audit log", async () => {
    expect(await runConnectorSmokeAction("discord")).toEqual({ ok: true, data: { ok: true, summary: "Read 6 channels", ms: 210 } })
    expect(smoke.runConnectorSmoke).toHaveBeenCalledWith(registry.connectors[0])
    expect(audit.createAuditLog).toHaveBeenCalledWith({
      actorUserId: "user-1",
      actionType: "SMOKE_TEST",
      entityType: "CONNECTOR",
      entityId: "discord",
      summary: "Ran the Discord smoke test: passed",
      metadata: { ok: true, summary: "Read 6 channels", ms: 210 },
    })
    expect(cache.revalidatePath).toHaveBeenCalledWith("/admin/connections")
  })

  it("says so when there's no smoke test, no such connector, or missing env", async () => {
    registry.connectors = [connector("discord")]
    expect(await runConnectorSmokeAction("discord")).toEqual({ ok: false, error: "This connection has no smoke test yet." })
    expect(await runConnectorSmokeAction("teams")).toEqual({ ok: false, error: expect.stringMatching(/no connection called that/) })

    registry.connectors = [connector("discord", { smoke: async () => ({ ok: true, summary: "" }) })]
    vi.stubEnv("DISCORD_BOT_TOKEN", "")
    expect(await runConnectorSmokeAction("discord")).toEqual({ ok: false, error: "Set it up first. Missing: DISCORD_BOT_TOKEN" })
    expect(smoke.runConnectorSmoke).not.toHaveBeenCalled()
    expect(audit.createAuditLog).not.toHaveBeenCalled()
  })
})
