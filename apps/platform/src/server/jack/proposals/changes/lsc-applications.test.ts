import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  league: { findUnique: vi.fn() },
  season: { findFirst: vi.fn() },
  user: { findFirst: vi.fn(), findUnique: vi.fn() },
  leagueApplication: { findUnique: vi.fn() },
}))
const entries = vi.hoisted(() => ({ getOpenLeagueSeason: vi.fn(), saveLeagueApplication: vi.fn() }))
const cache = vi.hoisted(() => ({ revalidatePaths: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/services/league-entry.service", () => entries)
vi.mock("@/server/cache/revalidate-public", () => cache)

import type { ImportCells, ProposalApplyContext } from "../types"
import { equipmentFrom, experienceFrom, isUt, lscApplicationTarget, yes } from "./lsc-applications"

const S3 = { id: "s3", name: "LSC Season 3", slug: "lsc-s3" }
const ana = { id: "u-ana", displayName: "Ana Torres", handle: "ana-torres", eid: null, status: "active" }
const meta = { via: "jack" as const, proposalId: "prop-1", roomId: "room-1", proposedFor: "u1" }
const applyCtx: ProposalApplyContext = { officer: { userId: "u2", displayName: "Gray" }, proposalId: "prop-1", roomId: "room-1", idempotencyKey: "proposal:prop-1", before: null, auditMetadata: meta }

const row = (cells: Partial<ImportCells> = {}): ImportCells => ({ email: "ana@example.com", name: "Ana Torres", discord: "ana_t", experience: "I actively play racing games or sims", equipment: "Steering wheel, Pedals", canCommit: "Yes", school: "", ...cells }) as ImportCells

beforeEach(() => {
  db.league.findUnique.mockResolvedValue({ id: "lsc" })
  entries.getOpenLeagueSeason.mockResolvedValue(S3)
  db.season.findFirst.mockResolvedValue({ id: "s2", name: "LSC Season 2", slug: "lsc-s2" })
  db.user.findFirst.mockResolvedValue(ana)
  db.user.findUnique.mockResolvedValue(null)
  db.leagueApplication.findUnique.mockResolvedValue(null)
  entries.saveLeagueApplication.mockResolvedValue({ id: "app-1" })
})

describe("reading a form's answers", () => {
  it("reads experience, equipment, yes and the school as the old import did", () => {
    expect(experienceFrom("I have competitive sim racing experience")).toBe("COMPETITIVE")
    expect(experienceFrom("sim_racer")).toBe("SIM_RACER")
    expect(experienceFrom("")).toBe("NONE")
    expect(equipmentFrom("Steering wheel, Pedals and a keyboard")).toEqual(["WHEEL", "PEDALS", "KEYBOARD"])
    expect(equipmentFrom("nothing yet")).toEqual([])
    expect(yes("Yes")).toBe(true)
    expect(yes("No, but yes on Saturdays")).toBe(true)
    expect(yes("no")).toBe(false)
    expect(isUt("")).toBe(true)
    expect(isUt("UT Austin")).toBe(true)
    expect(isUt("Texas A&M")).toBe(false)
  })
})

describe("the LSC applications target: validateRow", () => {
  it("finds the driver by email and checks the row as the entry form would", async () => {
    // Rows are checked several at a time; the season is looked up once
    const checks = await Promise.all([lscApplicationTarget.validateRow(row()), lscApplicationTarget.validateRow(row())])
    expect(checks[0]).toEqual({
      ok: true,
      label: "Ana Torres",
      detail: "Ana Torres (@ana-torres) · LSC Season 3 · Discord ana_t · Steering wheel, Pedals",
      status: "matched",
      key: "u-ana:s3",
      value: { userId: "u-ana", seasonId: "s3", seasonName: "LSC Season 3", input: { discordUsername: "ana_t", experience: "SIM_RACER", equipment: ["WHEEL", "PEDALS"], canCommit: true, utStudent: true } },
    })
    expect(db.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { email: { equals: "ana@example.com", mode: "insensitive" } } }))
  })

  it("falls back to the EID, saves it only on an account without one, and names another school", async () => {
    db.user.findFirst.mockResolvedValue(null)
    db.user.findUnique.mockImplementation(async ({ where }: { where: { eid?: string } }) => (where.eid === "abc123" ? { ...ana, eid: null } : null))
    const byEid = await lscApplicationTarget.validateRow(row({ email: "old@school.edu", eid: "ABC123" }))
    expect(byEid).toMatchObject({ ok: true })
    // The EID belongs to the account it found, so it isn't "free"
    expect(byEid.ok && byEid.value.input.eid).toBeUndefined()
    db.user.findFirst.mockResolvedValue(ana)
    db.user.findUnique.mockResolvedValue(null)
    const withEid = await lscApplicationTarget.validateRow(row({ eid: "xyz789" }))
    expect(withEid.ok && withEid.value.input).toMatchObject({ eid: "xyz789", utStudent: true })
    const other = await lscApplicationTarget.validateRow(row({ school: "Texas A&M" }))
    expect(other.ok && other.value.input).toMatchObject({ utStudent: false, school: "Texas A&M" })
    expect(other.ok && other.detail).toContain("· Texas A&M")
  })

  it("looks a season up again after a lookup that failed, or after a while", async () => {
    const S4 = { id: "s4", name: "LSC Season 4", slug: "lsc-s4" }
    db.season.findFirst.mockRejectedValueOnce(new Error("connection reset")).mockResolvedValue(S4)
    await expect(lscApplicationTarget.validateRow(row({ season: "lsc-s4" }))).rejects.toThrow("connection reset")
    expect(await lscApplicationTarget.validateRow(row({ season: "lsc-s4" }))).toMatchObject({ ok: true, key: "u-ana:s4" })
    expect(await lscApplicationTarget.validateRow(row({ season: "LSC-S4 " }))).toMatchObject({ ok: true, key: "u-ana:s4" })
    expect(db.season.findFirst).toHaveBeenCalledTimes(2)
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      vi.setSystemTime(Date.now() + 31_000)
      await lscApplicationTarget.validateRow(row({ season: "lsc-s4" }))
      expect(db.season.findFirst).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it("says why a row can't go in", async () => {
    const error = async (cells: Partial<ImportCells>) => {
      const check = await lscApplicationTarget.validateRow(row(cells))
      return check.ok ? null : check.error
    }
    expect(await error({ email: "", eid: "" })).toBe("No email or UT EID to find their site account by.")
    expect(await error({ equipment: "nothing" })).toBe("No equipment named (wheel, pedals, controller or keyboard).")
    expect(await error({ discord: "" })).toBe("Enter your Discord username.")
    db.leagueApplication.findUnique.mockResolvedValue({ source: "SITE" })
    expect(await error({})).toBe("Ana Torres already has an entry form for LSC Season 3; edit it on LSC entries.")
    db.user.findFirst.mockResolvedValue(null)
    expect(await error({})).toBe("No site account has this email or UT EID: they need to sign up on the site first.")
    entries.getOpenLeagueSeason.mockResolvedValue(null)
    db.season.findFirst.mockResolvedValue(null)
    expect(await error({ season: "Season 9" })).toBe("No Lone Star Cup season “Season 9”.")
  })
})

describe("the LSC applications target: applyRows", () => {
  const value = {
    userId: "u-ana",
    seasonId: "s3",
    seasonName: "LSC Season 3",
    input: { discordUsername: "ana_t", experience: "SIM_RACER" as const, equipment: ["WHEEL" as const], canCommit: true, utStudent: true, eid: undefined, school: undefined, notes: undefined },
  }

  it("saves each entry form through the league-entry service as the applying officer, source ADMIN", async () => {
    const result = await lscApplicationTarget.applyRows([{ rowId: "r1", value }], applyCtx)
    expect(entries.saveLeagueApplication).toHaveBeenCalledWith({ userId: "u-ana", seasonId: "s3", input: value.input, actorUserId: "u2", source: "ADMIN", auditMetadata: meta })
    expect(cache.revalidatePaths).toHaveBeenCalledWith(["/admin/league-entries", "/lone-star-cup"])
    expect(result).toEqual({ summary: "Added 1 LSC entry form (LSC Season 3).", links: [{ title: "LSC entries", url: "/admin/league-entries" }], appliedRows: ["r1"], counts: { added: 1, skipped: 0 } })
  })

  it("leaves out drivers who entered meanwhile, and reports rows that couldn't be saved", async () => {
    db.leagueApplication.findUnique.mockResolvedValueOnce({ id: "app-0" }).mockResolvedValue(null)
    entries.saveLeagueApplication.mockRejectedValueOnce(new Error("That UT EID is already on another account."))
    const result = await lscApplicationTarget.applyRows(
      [
        { rowId: "r1", value },
        { rowId: "r2", value: { ...value, userId: "u-b" } },
        { rowId: "r3", value: { ...value, userId: "u-c" } },
      ],
      applyCtx,
    )
    expect(result.summary).toBe("Added 1 LSC entry form (LSC Season 3). 2 rows weren't added: a driver already had an entry form; That UT EID is already on another account.")
    expect(result.appliedRows).toEqual(["r3"])
    db.leagueApplication.findUnique.mockResolvedValue({ id: "app-0" })
    await expect(lscApplicationTarget.applyRows([{ rowId: "r1", value }], applyCtx)).rejects.toThrow("No entry forms were added: a driver already had an entry form.")
  })
})
