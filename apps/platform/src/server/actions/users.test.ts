import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => {
  const db = {
    user: { findUnique: vi.fn(), update: vi.fn() },
    userRole: { count: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    role: { findMany: vi.fn() },
    membershipTier: { findUnique: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  }
  return db
})
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/auth/guards", () => ({ requireOfficer: vi.fn(async () => ({ id: "admin-1" })) }))
vi.mock("@/server/audit/log", () => audit)
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/server/cache/revalidate-public", () => ({ revalidateDriverList: vi.fn() }))
vi.mock("@/server/services/membership.service", () => ({ syncManualMembershipEntitlement: vi.fn(async () => null) }))

import { updateUser, type UpdateUserPayload } from "./users"

const payload = (overrides: Partial<UpdateUserPayload> = {}): UpdateUserPayload => ({
  displayName: "Test Officer",
  handle: "test-officer",
  bio: null,
  iRating: null,
  gradYear: 2030,
  major: "Example Major",
  socials: null,
  officerTitle: "Example Lead",
  department: "media",
  isBoard: true,
  workingOn: "Photos, video and the brand",
  roleKeys: ["officer"],
  activeMembershipTierKey: null,
  activeMembershipValidTo: null,
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  db.user.findUnique.mockResolvedValue({
    id: "user-1",
    displayName: "Test Officer",
    handle: "test-officer",
    department: null,
    isBoard: false,
    workingOn: null,
    officerTitle: "Example Lead",
    roles: [{ role: { key: "officer" } }],
    memberships: [],
  })
  // The editor is an admin, so officer accounts are theirs to edit
  db.userRole.count.mockResolvedValue(1)
  db.role.findMany.mockResolvedValue([{ id: "role-officer", key: "officer" }])
})

describe("updateUser: the officer profile", () => {
  it("saves department, board seat and what they work on, and audits the change", async () => {
    expect(await updateUser("user-1", payload())).toEqual({ ok: true })
    expect(db.user.update.mock.calls[0][0].data).toMatchObject({ department: "media", isBoard: true, workingOn: "Photos, video and the brand" })
    const entry = audit.createAuditLog.mock.calls[0][0]
    expect(entry.before).toMatchObject({ department: null, isBoard: false, workingOn: null })
    expect(entry.after).toMatchObject({ department: "media", isBoard: true, workingOn: "Photos, video and the brand" })
  })

  it("refuses a department that isn't on the roster, or a note over 160 characters, before saving anything", async () => {
    expect(await updateUser("user-1", payload({ department: "marketing" }))).toEqual({ ok: false, error: "Pick a department from the list." })
    expect(await updateUser("user-1", payload({ workingOn: "x".repeat(161) }))).toMatchObject({ ok: false, error: expect.stringMatching(/160 characters/) })
    expect(db.user.update).not.toHaveBeenCalled()
  })

  it("stores blanks as none", async () => {
    await updateUser("user-1", payload({ department: null, isBoard: false, workingOn: "  " }))
    expect(db.user.update.mock.calls[0][0].data).toMatchObject({ department: null, isBoard: false, workingOn: null })
  })

  it("keeps the profile to officers: anyone else gets none, whatever the form sent", async () => {
    // A member, or an officer losing the role
    await updateUser("user-1", payload({ roleKeys: [] }))
    expect(db.user.update.mock.calls[0][0].data).toMatchObject({ department: null, isBoard: false, workingOn: null })
    expect(audit.createAuditLog.mock.calls[0][0].after).toMatchObject({ department: null, isBoard: false, workingOn: null })
  })

  it("refuses a non-admin officer changing another officer's profile, and saves nothing", async () => {
    db.userRole.count.mockResolvedValue(0)
    expect(await updateUser("user-1", payload({ workingOn: "Something else" }))).toEqual({ ok: false, error: "Only admins can edit officer and admin accounts." })
    expect(db.user.update).not.toHaveBeenCalled()
    expect(db.userRole.deleteMany).not.toHaveBeenCalled()
    expect(audit.createAuditLog).not.toHaveBeenCalled()
  })

  it("lets a non-admin officer edit a member, without giving them a profile", async () => {
    db.userRole.count.mockResolvedValue(0)
    db.user.findUnique.mockResolvedValueOnce({ id: "user-2", displayName: "Test Member", handle: "test-member", roles: [], memberships: [] })
    db.role.findMany.mockResolvedValueOnce([])
    expect(await updateUser("user-2", payload({ displayName: "Test Member", handle: "test-member", roleKeys: [], department: "media", isBoard: true }))).toEqual({ ok: true })
    expect(db.user.update.mock.calls[0][0].data).toMatchObject({ department: null, isBoard: false, workingOn: null })
  })
})
