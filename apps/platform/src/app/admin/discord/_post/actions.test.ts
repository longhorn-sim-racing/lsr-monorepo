import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ userRole: { count: vi.fn() }, discordRoleRule: { findUnique: vi.fn() } }))
const guards = vi.hoisted(() => ({ requireOfficer: vi.fn() }))
const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }))
const connection = vi.hoisted(() => ({ discordPostingForPage: vi.fn(), NOT_CONNECTED: "Discord isn't connected." }))
const roleSync = vi.hoisted(() => ({ readRoles: vi.fn(), createRoleRule: vi.fn(), setRoleRuleEnabled: vi.fn(), deleteRoleRule: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/auth/guards", () => guards)
vi.mock("next/cache", () => cache)
vi.mock("@/server/discord-post/connection", () => connection)
vi.mock("@/server/discord-post/role-sync", () => roleSync)

import { createRoleRuleAction, deleteRoleRuleAction, setRoleRuleEnabledAction } from "./actions"

const GUILD = "1100000000000000000"
const PLAIN = { id: "1100000000000000011", name: "LSC Driver", position: 2, permissions: "0", managed: false, mentionable: true }
const MODS = { id: "1100000000000000012", name: "Mods", position: 2, permissions: "8192", managed: false, mentionable: false }

beforeEach(() => {
  vi.clearAllMocks()
  guards.requireOfficer.mockResolvedValue({ id: "admin-1" })
  db.userRole.count.mockResolvedValue(1)
  db.discordRoleRule.findUnique.mockResolvedValue({ roleId: PLAIN.id })
  connection.discordPostingForPage.mockResolvedValue({ client: {}, writer: { guildId: GUILD } })
  roleSync.readRoles.mockResolvedValue({ roles: [PLAIN, MODS], botTop: 3, botRoleIds: [], mentionEveryone: false })
  roleSync.createRoleRule.mockResolvedValue({ ok: true, rule: { id: "rr-1" } })
  roleSync.setRoleRuleEnabled.mockResolvedValue({ ok: true, changed: true })
  roleSync.deleteRoleRule.mockResolvedValue({ ok: true })
})

describe("role sync rules", () => {
  it("are changed by admins only", async () => {
    db.userRole.count.mockResolvedValue(0)
    expect(await createRoleRuleAction({ roleId: PLAIN.id, condition: "linked", enabled: true })).toMatchObject({ ok: false, error: "Only admins can change role sync." })
    expect(await setRoleRuleEnabledAction("rr-1", false)).toMatchObject({ ok: false })
    expect(await deleteRoleRuleAction("rr-1")).toMatchObject({ ok: false })
    expect(roleSync.createRoleRule).not.toHaveBeenCalled()
  })

  it("are added against Discord's live roles", async () => {
    expect(await createRoleRuleAction({ roleId: PLAIN.id, condition: "linked", enabled: true })).toEqual({ ok: true })
    expect(roleSync.createRoleRule).toHaveBeenCalledWith({ roleId: PLAIN.id, condition: "linked", enabled: true }, { userId: "admin-1" }, expect.objectContaining({ botTop: 3, guildId: GUILD }))
    connection.discordPostingForPage.mockResolvedValue(null)
    expect(await createRoleRuleAction({ roleId: PLAIN.id, condition: "linked", enabled: true })).toMatchObject({ ok: false, error: expect.stringMatching(/isn't connected/) })
  })

  it("are switched on only for a role that's still safe; off always works", async () => {
    expect(await setRoleRuleEnabledAction("rr-1", true)).toEqual({ ok: true })
    db.discordRoleRule.findUnique.mockResolvedValue({ roleId: MODS.id })
    expect(await setRoleRuleEnabledAction("rr-1", true)).toMatchObject({ ok: false, error: expect.stringMatching(/moderation permissions/) })
    connection.discordPostingForPage.mockResolvedValue(null)
    expect(await setRoleRuleEnabledAction("rr-1", false)).toEqual({ ok: true })
    expect(roleSync.setRoleRuleEnabled).toHaveBeenLastCalledWith("rr-1", false, { userId: "admin-1" }, undefined)
  })
})
