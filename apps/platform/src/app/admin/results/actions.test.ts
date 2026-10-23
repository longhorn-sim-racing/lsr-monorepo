import { beforeEach, describe, expect, it, vi } from "vitest"

// The actions run for real on top of the results service; only Prisma, the guard and Next are fakes
const db = vi.hoisted(() => ({
  rawResultUpload: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() },
  raceSession: { count: vi.fn(), create: vi.fn() },
  driverIdentity: { upsert: vi.fn(), findMany: vi.fn() },
  parseReport: { upsert: vi.fn() },
  event: { findUnique: vi.fn() },
  carMapping: { findMany: vi.fn() },
  raceParticipant: { create: vi.fn() },
  raceResult: { create: vi.fn(), updateMany: vi.fn() },
  raceLap: { createMany: vi.fn() },
  raceEvent: { createMany: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}))
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))
const next = vi.hoisted(() => ({ revalidatePath: vi.fn() }))
const guards = vi.hoisted(() => ({ requireOfficer: vi.fn() }))

vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/audit/log", () => audit)
vi.mock("@/server/auth/guards", () => guards)
vi.mock("next/cache", () => ({ revalidatePath: next.revalidatePath }))

import { bindEventToUpload, ingestUpload, previewParseResult, uploadResult } from "./actions"

const raceFile = {
  TrackName: "ks_laguna_seca",
  Date: "2026-10-10T17:30:00Z",
  Cars: [{ CarId: 0, Model: "ks_mazda_mx5_cup", Driver: { Guid: "gA", Name: "Ana" } }],
  Result: [{ DriverGuid: "gA", DriverName: "Ana", CarId: 0, CarModel: "ks_mazda_mx5_cup", LapCount: 1 }],
  Laps: [{ DriverGuid: "gA", CarId: 0, LapTime: 100000, Cuts: 0, Timestamp: 1 }],
  Events: [],
}

const revalidated = () => next.revalidatePath.mock.calls.map(([path]) => path)

beforeEach(() => {
  guards.requireOfficer.mockResolvedValue({ id: "officer-1" })
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db))
  db.raceSession.count.mockResolvedValue(0)
  db.driverIdentity.findMany.mockResolvedValue([])
  db.carMapping.findMany.mockResolvedValue([])
})

describe("uploadResult", () => {
  const upload = (file?: File) => {
    const data = new FormData()
    if (file) data.set("file", file)
    return data
  }

  it("stores the file and returns only its id and status", async () => {
    db.rawResultUpload.create.mockResolvedValue({ id: "up1", status: "UPLOADED", rawJson: raceFile })
    const result = await uploadResult(upload(new File([JSON.stringify(raceFile)], "race.json")))

    expect(result).toEqual({ ok: true, data: { id: "up1", status: "UPLOADED" } })
    expect(db.rawResultUpload.create.mock.calls[0][0].data).toMatchObject({ filename: "race.json", rawJson: raceFile, uploadedByUserId: "officer-1" })
    expect(revalidated()).toEqual(["/admin/results"])
  })

  it("asks for a file, and refuses one that isn't JSON", async () => {
    expect(await uploadResult(upload())).toEqual({ ok: false, error: "Choose a results file to upload." })
    expect(await uploadResult(upload(new File([""], "empty.json")))).toEqual({ ok: false, error: "Choose a results file to upload." })
    expect(await uploadResult(upload(new File(["nope"], "notes.txt")))).toEqual({
      ok: false,
      error: "notes.txt isn't valid JSON. Upload the results .json file the server saved.",
    })
    expect(db.rawResultUpload.create).not.toHaveBeenCalled()
    expect(next.revalidatePath).not.toHaveBeenCalled()
  })
})

describe("previewParseResult", () => {
  beforeEach(() => {
    db.rawResultUpload.findUnique.mockResolvedValue({ id: "up1", filename: "race.json", status: "UPLOADED", rawJson: raceFile })
    db.rawResultUpload.update.mockImplementation(async ({ data }: { data: { status: string } }) => ({ id: "up1", filename: "race.json", status: data.status }))
  })

  it("parses, saving the drivers and report, and refreshes the upload and the list", async () => {
    expect(await previewParseResult("up1")).toEqual({ ok: true, data: { id: "up1", status: "PARSED" } })
    expect(db.driverIdentity.upsert).toHaveBeenCalledTimes(1)
    expect(db.parseReport.upsert).toHaveBeenCalledTimes(1)
    expect(revalidated()).toEqual(["/admin/results/up1", "/admin/results"])
  })

  it("refuses an ingested upload", async () => {
    db.rawResultUpload.findUnique.mockResolvedValue({ id: "up1", status: "INGESTED", rawJson: raceFile })
    expect(await previewParseResult("up1")).toEqual({
      ok: false,
      error: "These results are already ingested. Delete them with their race records to parse the file again.",
    })
    expect(next.revalidatePath).not.toHaveBeenCalled()
  })
})

describe("bindEventToUpload", () => {
  it("links the event (no points for qualifying) and refreshes the upload page", async () => {
    db.event.findUnique.mockResolvedValue({ id: "ev1", title: "LSC Round 3" })
    expect(await bindEventToUpload("up1", "ev1", "F1", "QUALIFYING")).toEqual({ ok: true })
    expect(db.rawResultUpload.update).toHaveBeenCalledWith({ where: { id: "up1" }, data: { eventId: "ev1", pointsSystem: "NONE", sessionLabel: "QUALIFYING" } })
    expect(revalidated()).toEqual(["/admin/results/up1"])
  })
})

describe("ingestUpload", () => {
  it("ingests and refreshes the upload and the public pages the results show on", async () => {
    const row = { id: "up1", status: "PARSED", eventId: "ev1", pointsSystem: "F1", sessionLabel: "RACE", rawJson: raceFile }
    db.rawResultUpload.findUnique.mockImplementation(async ({ select }: { select?: object }) => (select ? { eventId: "ev1", pointsSystem: "F1", sessionLabel: "RACE" } : row))
    db.raceSession.create.mockResolvedValue({ id: "s1" })
    db.raceParticipant.create.mockResolvedValue({ id: "p1" })
    db.event.findUnique.mockResolvedValue({ slug: "lsc-r3" })

    expect(await ingestUpload("up1")).toEqual({ ok: true })
    expect(db.rawResultUpload.update).toHaveBeenCalledWith({ where: { id: "up1" }, data: { status: "INGESTED" } })
    expect(new Set(revalidated())).toEqual(new Set(["/admin/results/up1", "/drivers", "/events/lsc-r3", "/events", "/lone-star-cup"]))
  })

  it("stops at the guard", async () => {
    guards.requireOfficer.mockRejectedValue(new Error("Requires one of the following roles: admin, officer"))
    await expect(ingestUpload("up1")).rejects.toThrow("Requires one of")
    expect(db.rawResultUpload.findUnique).not.toHaveBeenCalled()
  })
})
