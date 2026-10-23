import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ user: { update: vi.fn() }, userRole: { count: vi.fn() } }))
const guards = vi.hoisted(() => ({ requireUser: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/auth/guards", () => guards)
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/server/cache/revalidate-public", () => ({ revalidateDriverList: vi.fn() }))
vi.mock("@/server/services/eid.service", () => ({ EID_TAKEN: "taken", setUserEid: vi.fn() }))
vi.mock("@/app/admin/tools/actions", () => ({ getLeorgeGawrenceEnforcementUnitStatus: vi.fn(async () => false) }))

import { updateProfile } from "./actions"

/** The profile form as the page posts it: every driver field, blank unless given */
function form(fields: Record<string, string>) {
  const data = new FormData()
  const base = { displayName: "Gray Marshall", major: "", gradYear: "", iRating: "", bio: "", website: "", instagram: "", twitch: "", youtube: "" }
  for (const [key, value] of Object.entries({ ...base, ...fields })) data.set(key, value)
  return data
}

const savedData = () => db.user.update.mock.calls[0][0].data

beforeEach(() => {
  vi.clearAllMocks()
  guards.requireUser.mockResolvedValue({ id: "user-1", handle: "gray-marshall", socials: null })
  db.userRole.count.mockResolvedValue(1)
})

describe("updateProfile: the officer profile", () => {
  it("saves an officer's department, board seat and what they work on", async () => {
    await updateProfile(form({ department: "technology", isBoard: "on", workingOn: "The website and Jack" }))
    expect(savedData()).toMatchObject({ displayName: "Gray Marshall", department: "technology", isBoard: true, workingOn: "The website and Jack" })
  })

  it("clears them when an officer empties them", async () => {
    await updateProfile(form({ department: "", workingOn: "" }))
    expect(savedData()).toMatchObject({ department: null, isBoard: false, workingOn: null })
  })

  it("ignores them from someone who isn't an officer", async () => {
    db.userRole.count.mockResolvedValue(0)
    await updateProfile(form({ department: "executive", isBoard: "on", workingOn: "Running the club" }))
    expect(savedData()).not.toHaveProperty("department")
    expect(savedData()).not.toHaveProperty("isBoard")
    expect(savedData()).not.toHaveProperty("workingOn")
  })

  it("leaves them alone when the form didn't have the step", async () => {
    await updateProfile(form({}))
    expect(savedData()).not.toHaveProperty("department")
  })

  it("refuses a department that isn't on the roster, and an over-long note", async () => {
    await expect(updateProfile(form({ department: "marketing" }))).rejects.toThrow("Pick a department from the list.")
    await expect(updateProfile(form({ department: "media", workingOn: "x".repeat(161) }))).rejects.toThrow(/160 characters/)
    expect(db.user.update).not.toHaveBeenCalled()
  })
})
