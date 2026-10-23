import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"

// Stand-ins for the Prisma client (`db`) and the transaction client (`tx`) that `db.$transaction` hands its
// callback. They're separate fakes, so a test can tell what runs under the row lock from what runs before it.
const { db, tx } = vi.hoisted(() => {
  const client = () => ({
    rawResultUpload: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
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
  })
  return { db: client(), tx: client() }
})
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))

vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/audit/log", () => audit)

import {
  ALREADY_INGESTED,
  bindUpload,
  calculatePoints,
  createUpload,
  ingestUpload,
  parseResultFile,
  parseUpload,
  previewResultFile,
} from "./results.service"

const officer = { userId: "officer-1" }
const viaJack = { userId: "officer-2", auditMetadata: { via: "jack", proposalId: "p1" } }

/** A small race: three cars (one without a GUID), and car 3 driven by the same driver as car 0 */
const raceFile = () => ({
  TrackName: "ks_laguna_seca",
  TrackConfig: "",
  Date: "2026-10-10T17:30:00Z",
  Cars: [
    { CarId: 0, Model: "ks_mazda_mx5_cup", Skin: "red", BallastKG: 0, Restrictor: 0, Driver: { Guid: "gA", Name: "Ana", Team: "LSR", Nation: "USA", ClassID: "mx5" } },
    { CarId: 1, Model: "ks_mazda_mx5_cup", Skin: "blue", Driver: { Guid: "gB", Name: "Ben" } },
    { CarId: 2, Model: "unmapped_car", Driver: { Name: "" } },
    { CarId: 3, Model: "ks_mazda_mx5_cup", Driver: { Guid: "gA", Name: "Ana" } },
  ],
  Result: [
    { DriverGuid: "gB", DriverName: "Ben", CarId: 1, CarModel: "ks_mazda_mx5_cup", BestLap: 101000, TotalTime: 1500000, LapCount: 15, Gap: "" },
    { DriverGuid: "gA", DriverName: "Ana", CarId: 0, CarModel: "ks_mazda_mx5_cup", BestLap: 100500, TotalTime: 1502000, LapCount: 15, Disqualified: true, PenaltyTime: 5000, LapPenalty: 0 },
    { DriverGuid: "", DriverName: "", CarId: 2, CarModel: "unmapped_car" },
    { DriverGuid: "gZ", DriverName: "Ghost", CarId: 9, CarModel: "x" },
  ],
  Laps: [
    { DriverGuid: "gA", CarId: 0, LapTime: 101000, Sectors: [30000, 40000, 31000], Cuts: 0, Tyre: "SM", Timestamp: 200 },
    { DriverGuid: "gB", CarId: 1, LapTime: 102000, Sectors: [31000, 40000, 31000], Cuts: 2, Tyre: "SM", Timestamp: 150 },
    { DriverGuid: "gA", CarId: 0, LapTime: 103000, Cuts: 1, Timestamp: 100 },
    { CarId: 3, LapTime: 104000, Cuts: 0, Timestamp: 300 },
    { DriverGuid: "gZ", CarId: 9, LapTime: 99000, Cuts: 0, Timestamp: 50 },
  ],
  Events: [
    { Type: "COLLISION_WITH_CAR", CarId: 0, Driver: { Guid: "gA" }, OtherCarId: 1, OtherDriver: { Guid: "gB" }, ImpactSpeed: 12.5, WorldPosition: { X: 1, Y: 2, Z: 3 }, RelPosition: { X: 0.1, Y: 0.2, Z: 0.3 } },
    { Type: "COLLISION_WITH_ENV", CarId: 1, Driver: { Guid: "gB" }, OtherCarId: -1, ImpactSpeed: 30 },
  ],
})

/** The order calls were made in, across fakes: `callOrder(a) < callOrder(b)` means a's first call came first */
const callOrder = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0] ?? Infinity

/** The SQL of a tagged-template $queryRaw call, with its values as "?" */
const sqlOf = (call: unknown[]) => (call[0] as string[]).join("?")

beforeEach(() => {
  db.$transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) => fn(tx))
  db.raceSession.count.mockResolvedValue(0)
  tx.raceSession.count.mockResolvedValue(0)
  db.driverIdentity.findMany.mockResolvedValue([])
})

describe("createUpload", () => {
  it("stores the file with its size and hash, audits it and refreshes the results list", async () => {
    db.rawResultUpload.create.mockResolvedValue({ id: "up1", status: "UPLOADED" })
    const text = JSON.stringify(raceFile())
    const bytes = new TextEncoder().encode(text)

    const result = await createUpload({ filename: "race.json", bytes: bytes.buffer as ArrayBuffer }, officer)

    const sha256 = createHash("sha256").update(bytes).digest("hex")
    expect(db.rawResultUpload.create).toHaveBeenCalledWith({
      data: { filename: "race.json", filesize: bytes.byteLength, sha256, rawJson: raceFile(), uploadedByUserId: "officer-1" },
      select: { id: true, status: true },
    })
    expect(audit.createAuditLog).toHaveBeenCalledWith({
      actorUserId: "officer-1",
      actionType: "CREATE",
      entityType: "RESULT_UPLOAD",
      entityId: "up1",
      summary: "Uploaded result file: race.json",
      metadata: { filesize: bytes.byteLength, sha256 },
    })
    expect(result).toEqual({ ok: true, upload: { id: "up1", status: "UPLOADED" }, revalidate: ["/admin/results"] })
  })

  it("refuses a file that isn't JSON", async () => {
    const bytes = new TextEncoder().encode("{ not json")
    expect(await createUpload({ filename: "notes.txt", bytes: bytes.buffer as ArrayBuffer }, officer)).toEqual({
      ok: false,
      error: "notes.txt isn't valid JSON. Upload the results .json file the server saved.",
    })
    expect(db.rawResultUpload.create).not.toHaveBeenCalled()
  })
})

describe("parseResultFile", () => {
  it("lists each driver once, with counts", () => {
    expect(parseResultFile(raceFile())).toEqual({
      ok: true,
      status: "FAILED",
      report: {
        drivers: [
          { guid: "gB", driverName: "Ben", carModel: "ks_mazda_mx5_cup" },
          { guid: "gA", driverName: "Ana", carModel: "ks_mazda_mx5_cup" },
          { guid: "gZ", driverName: "Ghost", carModel: "x" },
        ],
        resultsCount: 4,
        lapsCount: 5,
        // The row without a GUID is an anomaly, which fails the parse
        anomalies: ["Missing driver GUID in result entry"],
      },
    })
  })

  it("passes a clean file", () => {
    const file = raceFile()
    file.Result = file.Result.filter((row) => row.DriverGuid)
    expect(parseResultFile(file)).toMatchObject({ ok: true, status: "PARSED", report: { anomalies: [] } })
  })

  it("flags missing lists, and refuses what isn't an object", () => {
    expect(parseResultFile({})).toMatchObject({
      ok: true,
      status: "FAILED",
      report: { drivers: [], resultsCount: 0, lapsCount: 0, anomalies: ["Missing or invalid 'Result' array", "Missing or invalid 'Laps' array"] },
    })
    expect(parseResultFile(null)).toEqual({ ok: false, error: "This file isn't a results file: it has no session data." })
    expect(parseResultFile("text")).toMatchObject({ ok: false })
  })
})

describe("parseUpload", () => {
  const upload = (extra: Record<string, unknown> = {}) => ({ id: "up1", filename: "race.json", status: "UPLOADED", rawJson: raceFile(), ...extra })

  beforeEach(() => {
    db.rawResultUpload.findUnique.mockResolvedValue(upload())
    db.driverIdentity.findMany.mockResolvedValue([{ driverGuid: "gA" }])
    db.rawResultUpload.update.mockImplementation(async ({ data }: { data: { status: string } }) => ({ id: "up1", status: data.status, filename: "race.json" }))
  })

  it("without writing: reports the drivers and who isn't linked to a member, and touches nothing", async () => {
    const result = await parseUpload("up1", { write: false })

    expect(result).toEqual({
      ok: true,
      upload: { id: "up1", status: "FAILED" },
      report: expect.objectContaining({ resultsCount: 4, anomalies: ["Missing driver GUID in result entry"] }),
      unmatchedDrivers: [
        { guid: "gB", driverName: "Ben", carModel: "ks_mazda_mx5_cup" },
        { guid: "gZ", driverName: "Ghost", carModel: "x" },
      ],
      revalidate: [],
    })
    expect(db.driverIdentity.findMany).toHaveBeenCalledWith({
      where: { driverGuid: { in: ["gB", "gA", "gZ"] }, userId: { not: null } },
      select: { driverGuid: true },
    })
    expect(db.driverIdentity.upsert).not.toHaveBeenCalled()
    expect(db.parseReport.upsert).not.toHaveBeenCalled()
    expect(db.rawResultUpload.update).not.toHaveBeenCalled()
    expect(audit.createAuditLog).not.toHaveBeenCalled()
  })

  it("with writing: records each driver, saves the report and status, and audits", async () => {
    const result = await parseUpload("up1", { write: true, actor: officer })

    expect(db.driverIdentity.upsert.mock.calls.map(([args]) => args)).toEqual([
      { where: { driverGuid: "gB" }, create: { driverGuid: "gB", lastSeenName: "Ben" }, update: { lastSeenName: "Ben" } },
      { where: { driverGuid: "gA" }, create: { driverGuid: "gA", lastSeenName: "Ana" }, update: { lastSeenName: "Ana" } },
      { where: { driverGuid: "gZ" }, create: { driverGuid: "gZ", lastSeenName: "Ghost" }, update: { lastSeenName: "Ghost" } },
    ])
    const report = {
      drivers: [
        { guid: "gB", driverName: "Ben", carModel: "ks_mazda_mx5_cup" },
        { guid: "gA", driverName: "Ana", carModel: "ks_mazda_mx5_cup" },
        { guid: "gZ", driverName: "Ghost", carModel: "x" },
      ],
      resultsCount: 4,
      lapsCount: 5,
      anomalies: ["Missing driver GUID in result entry"],
    }
    expect(db.parseReport.upsert).toHaveBeenCalledWith({ where: { uploadId: "up1" }, create: { uploadId: "up1", ...report }, update: report })
    expect(db.rawResultUpload.update).toHaveBeenCalledWith({
      where: { id: "up1" },
      data: { status: "FAILED", errorMessage: "Missing driver GUID in result entry" },
      select: { id: true, status: true, filename: true },
    })
    expect(audit.createAuditLog).toHaveBeenCalledWith({
      actorUserId: "officer-1",
      actionType: "UPDATE",
      entityType: "RESULT_UPLOAD",
      entityId: "up1",
      summary: "Parsed result upload: race.json",
      metadata: { status: "FAILED", anomalies: ["Missing driver GUID in result entry"] },
    })
    expect(result).toMatchObject({ ok: true, upload: { id: "up1", status: "FAILED" }, revalidate: ["/admin/results/up1", "/admin/results"] })
  })

  it("with writing: a clean file is PARSED with no error message", async () => {
    const file = raceFile()
    file.Result = file.Result.filter((row) => row.DriverGuid)
    db.rawResultUpload.findUnique.mockResolvedValue(upload({ rawJson: file }))

    await parseUpload("up1", { write: true, actor: viaJack })

    expect(db.rawResultUpload.update.mock.calls[0][0].data).toEqual({ status: "PARSED", errorMessage: null })
    expect(audit.createAuditLog.mock.calls[0][0]).toMatchObject({ actorUserId: "officer-2", metadata: { via: "jack", proposalId: "p1", status: "PARSED", anomalies: [] } })
  })

  it("a file that isn't a results file fails the upload only when writing", async () => {
    db.rawResultUpload.findUnique.mockResolvedValue(upload({ rawJson: "just text" }))
    const error = { ok: false, error: "This file isn't a results file: it has no session data." }

    expect(await parseUpload("up1", { write: false })).toEqual(error)
    expect(db.rawResultUpload.update).not.toHaveBeenCalled()

    expect(await parseUpload("up1", { write: true, actor: officer })).toEqual(error)
    expect(db.rawResultUpload.update).toHaveBeenCalledWith({ where: { id: "up1" }, data: { status: "FAILED", errorMessage: "Invalid JSON structure" } })
    expect(db.driverIdentity.upsert).not.toHaveBeenCalled()
  })

  it("a file it can't read (a null Result entry) is refused without writing, and still throws when writing", async () => {
    db.rawResultUpload.findUnique.mockResolvedValue(upload({ rawJson: { Result: [null], Laps: [] } }))

    expect(await parseUpload("up1", { write: false })).toEqual({ ok: false, error: "This file isn't a results file: it has no session data." })

    // The writing parse is unchanged: it throws before writing anything, as the admin page always has
    await expect(parseUpload("up1", { write: true, actor: officer })).rejects.toThrow(TypeError)
    expect(db.rawResultUpload.update).not.toHaveBeenCalled()
    expect(db.driverIdentity.upsert).not.toHaveBeenCalled()
    expect(audit.createAuditLog).not.toHaveBeenCalled()
  })

  it.each([{ write: false } as const, { write: true, actor: officer } as const])("refuses an ingested upload (write: $write)", async (options) => {
    db.rawResultUpload.findUnique.mockResolvedValue(upload({ status: "INGESTED" }))
    expect(await parseUpload("up1", options)).toEqual({ ok: false, error: ALREADY_INGESTED })

    // Ingested means race sessions exist, whatever the status says
    db.rawResultUpload.findUnique.mockResolvedValue(upload({ status: "PARSED" }))
    db.raceSession.count.mockResolvedValue(1)
    expect(await parseUpload("up1", options)).toEqual({ ok: false, error: ALREADY_INGESTED })
    expect(db.driverIdentity.upsert).not.toHaveBeenCalled()
  })

  it("says so when the upload is gone", async () => {
    db.rawResultUpload.findUnique.mockResolvedValue(null)
    expect(await parseUpload("up1", { write: false })).toEqual({ ok: false, error: "That upload no longer exists. Go back to the results list." })
  })
})

describe("previewResultFile", () => {
  it("parses a file that isn't uploaded yet and lists unlinked drivers, writing nothing", async () => {
    db.driverIdentity.findMany.mockResolvedValue([{ driverGuid: "gB" }, { driverGuid: "gZ" }])
    const result = await previewResultFile(raceFile())
    expect(result).toMatchObject({ ok: true, status: "FAILED", unmatchedDrivers: [{ guid: "gA", driverName: "Ana", carModel: "ks_mazda_mx5_cup" }] })
    expect(db.driverIdentity.upsert).not.toHaveBeenCalled()
    expect(db.parseReport.upsert).not.toHaveBeenCalled()
  })

  it("skips the lookup when there are no drivers", async () => {
    expect(await previewResultFile({ Result: [], Laps: [] })).toMatchObject({ ok: true, status: "PARSED", unmatchedDrivers: [] })
    expect(db.driverIdentity.findMany).not.toHaveBeenCalled()
  })

  it("refuses a file it can't read instead of throwing", async () => {
    const error = { ok: false, error: "This file isn't a results file: it has no session data." }
    expect(await previewResultFile({ Result: [null], Laps: [] })).toEqual(error)
    expect(await previewResultFile({ Result: [{ DriverGuid: "gA", DriverName: "Ana", CarModel: "x" }, undefined], Laps: [] })).toEqual(error)
    expect(await previewResultFile(null)).toEqual(error)
    expect(db.driverIdentity.findMany).not.toHaveBeenCalled()
  })
})

describe("bindUpload", () => {
  beforeEach(() => db.event.findUnique.mockResolvedValue({ id: "ev1", title: "LSC Round 3" }))

  it("links the upload under the row lock, audits it and refreshes the upload page", async () => {
    const result = await bindUpload({ uploadId: "up1", eventId: "ev1", pointsSystem: "HALF", sessionLabel: "RACE" }, officer)

    // In the transaction: lock the row, check it isn't ingested, then write the link
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(sqlOf(tx.$queryRaw.mock.calls[0])).toContain('FROM "RawResultUpload" WHERE id = ? FOR UPDATE')
    expect(tx.$queryRaw.mock.calls[0][1]).toBe("up1")
    expect(tx.raceSession.count).toHaveBeenCalledWith({ where: { uploadId: "up1" } })
    expect(tx.rawResultUpload.update).toHaveBeenCalledWith({ where: { id: "up1" }, data: { eventId: "ev1", pointsSystem: "HALF", sessionLabel: "RACE" } })
    expect(callOrder(tx.$queryRaw)).toBeLessThan(callOrder(tx.raceSession.count))
    expect(callOrder(tx.raceSession.count)).toBeLessThan(callOrder(tx.rawResultUpload.update))
    // Nothing on the outer client, and the audit entry comes after the transaction
    expect(db.$queryRaw).not.toHaveBeenCalled()
    expect(db.raceSession.count).not.toHaveBeenCalled()
    expect(db.rawResultUpload.update).not.toHaveBeenCalled()
    expect(callOrder(tx.rawResultUpload.update)).toBeLessThan(callOrder(audit.createAuditLog))
    expect(audit.createAuditLog).toHaveBeenCalledWith({
      actorUserId: "officer-1",
      actionType: "UPDATE",
      entityType: "RESULT_UPLOAD",
      entityId: "up1",
      summary: "Bound upload to event LSC Round 3",
      metadata: { eventId: "ev1", pointsSystem: "HALF", sessionLabel: "RACE" },
    })
    expect(result).toEqual({
      ok: true,
      upload: { id: "up1", eventId: "ev1", pointsSystem: "HALF", sessionLabel: "RACE" },
      revalidate: ["/admin/results/up1"],
    })
  })

  it.each(["PRACTICE", "QUALIFYING"])("never awards points for %s", async (sessionLabel) => {
    await bindUpload({ uploadId: "up1", eventId: "ev1", pointsSystem: "F1", sessionLabel }, officer)
    expect(tx.rawResultUpload.update.mock.calls[0][0].data).toEqual({ eventId: "ev1", pointsSystem: "NONE", sessionLabel })
  })

  it("defaults the points system and label to none", async () => {
    await bindUpload({ uploadId: "up1", eventId: "ev1" }, officer)
    expect(tx.rawResultUpload.update.mock.calls[0][0].data).toEqual({ eventId: "ev1", pointsSystem: null, sessionLabel: null })
  })

  it("refuses a missing event before the transaction", async () => {
    db.event.findUnique.mockResolvedValueOnce(null)
    expect(await bindUpload({ uploadId: "up1", eventId: "gone" }, officer)).toEqual({ ok: false, error: "That event no longer exists. Refresh and pick another." })
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it("refuses an ingested upload, checked under the lock", async () => {
    tx.raceSession.count.mockResolvedValue(1)
    expect(await bindUpload({ uploadId: "up1", eventId: "ev1" }, officer)).toEqual({ ok: false, error: "These results are already ingested, so the event can't change." })
    expect(callOrder(tx.$queryRaw)).toBeLessThan(callOrder(tx.raceSession.count))
    expect(tx.rawResultUpload.update).not.toHaveBeenCalled()
    expect(db.rawResultUpload.update).not.toHaveBeenCalled()
    expect(audit.createAuditLog).not.toHaveBeenCalled()
  })
})

describe("calculatePoints", () => {
  it("scores F1 and HALF, and nothing else", () => {
    expect([1, 2, 3, 10, 11].map((p) => calculatePoints(p, "F1"))).toEqual([25, 18, 15, 1, 0])
    expect([1, 2, 10, 11].map((p) => calculatePoints(p, "HALF"))).toEqual([13, 9, 0.5, 0])
    expect(calculatePoints(1, "NONE")).toBe(0)
    expect(calculatePoints(1, null)).toBe(0)
  })
})

describe("ingestUpload", () => {
  const upload = (extra: Record<string, unknown> = {}) => ({
    id: "up1",
    status: "PARSED",
    eventId: "ev1",
    pointsSystem: "F1",
    sessionLabel: "RACE",
    rawJson: raceFile(),
    ...extra,
  })

  /** The upload as the pre-check reads it, and its link as the transaction reads it again under the lock */
  const stored = (extra: Record<string, unknown> = {}) => {
    const row = upload(extra)
    db.rawResultUpload.findUnique.mockResolvedValue(row)
    tx.rawResultUpload.findUnique.mockResolvedValue({ eventId: row.eventId, pointsSystem: row.pointsSystem, sessionLabel: row.sessionLabel })
  }

  beforeEach(() => {
    stored()
    tx.raceSession.create.mockResolvedValue({ id: "s1" })
    tx.driverIdentity.findMany.mockResolvedValue([{ driverGuid: "gA", userId: "user-ana" }, { driverGuid: "gB", userId: null }])
    tx.carMapping.findMany.mockResolvedValue([{ id: "cm-mx5", gameCarName: "ks_mazda_mx5_cup" }])
    tx.raceParticipant.create.mockImplementation(async ({ data }: { data: { driverGuid: string } }) => ({ id: `p-${data.driverGuid}` }))
    db.event.findUnique.mockResolvedValue({ slug: "lsc-r3" })
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  it("checks once outside, then locks the row and checks again before creating anything", async () => {
    await ingestUpload("up1", officer)

    // The pre-check runs once, on the outer client, before the transaction starts
    expect(db.raceSession.count).toHaveBeenCalledTimes(1)
    expect(callOrder(db.raceSession.count)).toBeLessThan(callOrder(db.$transaction))
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(db.$transaction.mock.calls[0][1]).toEqual({ maxWait: 20000, timeout: 20000 })

    // In the transaction: the FOR UPDATE lock, then the ingest check, then the link check, then the writes
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
    expect(sqlOf(tx.$queryRaw.mock.calls[0])).toContain('FROM "RawResultUpload" WHERE id = ? FOR UPDATE')
    expect(tx.$queryRaw.mock.calls[0][1]).toBe("up1")
    expect(tx.raceSession.count).toHaveBeenCalledWith({ where: { uploadId: "up1" } })
    expect(tx.rawResultUpload.findUnique).toHaveBeenCalledWith({ where: { id: "up1" }, select: { eventId: true, pointsSystem: true, sessionLabel: true } })
    expect(callOrder(tx.$queryRaw)).toBeLessThan(callOrder(tx.raceSession.count))
    expect(callOrder(tx.raceSession.count)).toBeLessThan(callOrder(tx.rawResultUpload.findUnique))
    expect(callOrder(tx.rawResultUpload.findUnique)).toBeLessThan(callOrder(tx.raceSession.create))

    // Nothing locks or writes on the outer client
    expect(db.$queryRaw).not.toHaveBeenCalled()
    expect(db.raceSession.create).not.toHaveBeenCalled()
    expect(db.rawResultUpload.update).not.toHaveBeenCalled()
  })

  it("creates the session, participants, results, laps and events, then marks the upload INGESTED", async () => {
    const result = await ingestUpload("up1", officer)

    expect(tx.raceSession.create).toHaveBeenCalledWith({
      data: {
        uploadId: "up1",
        eventId: "ev1",
        sessionType: "RACE",
        trackName: "ks_laguna_seca",
        trackConfig: "",
        startedAt: new Date("2026-10-10T17:30:00Z"),
        pointsSystem: "F1",
      },
    })
    expect(tx.driverIdentity.findMany).toHaveBeenCalledWith({ where: { driverGuid: { in: ["gA", "gB", "gZ"] } } })
    expect(tx.carMapping.findMany).toHaveBeenCalledWith({ where: { gameCarName: { in: ["ks_mazda_mx5_cup", "unmapped_car"] } } })

    // One participant per driver: car 3 is Ana again; the car without a GUID gets a placeholder
    expect(tx.raceParticipant.create.mock.calls.map(([args]) => args.data)).toEqual([
      {
        sessionId: "s1", driverGuid: "gA", displayName: "Ana", carName: "ks_mazda_mx5_cup", carMappingId: "cm-mx5", carClass: "mx5",
        teamName: "LSR", userId: "user-ana", carIdInSession: 0, nation: "USA", skin: "red", ballastKg: 0, restrictor: 0,
      },
      {
        sessionId: "s1", driverGuid: "gB", displayName: "Ben", carName: "ks_mazda_mx5_cup", carMappingId: "cm-mx5", carClass: "UNKNOWN",
        teamName: undefined, userId: null, carIdInSession: 1, nation: undefined, skin: "blue", ballastKg: undefined, restrictor: undefined,
      },
      {
        sessionId: "s1", driverGuid: "UNKNOWN_GUID_2", displayName: "Unknown", carName: "unmapped_car", carMappingId: undefined, carClass: "UNKNOWN",
        teamName: undefined, userId: undefined, carIdInSession: 2, nation: undefined, skin: undefined, ballastKg: undefined, restrictor: undefined,
      },
    ])

    // Results in file order; the GUID-less row matches by car; the unknown driver is skipped
    expect(tx.raceResult.create.mock.calls.map(([args]) => args.data)).toEqual([
      {
        sessionId: "s1", participantId: "p-gB", position: 1, classPosition: 0, bestLapTime: 101000, totalTime: 1500000, lapsCompleted: 15,
        status: "FINISHED", gap: "", points: 25, penaltyTime: undefined, lapPenalty: undefined, isDisqualified: false,
      },
      {
        sessionId: "s1", participantId: "p-gA", position: 2, classPosition: 0, bestLapTime: 100500, totalTime: 1502000, lapsCompleted: 15,
        status: "DSQ", gap: undefined, points: 18, penaltyTime: 5000, lapPenalty: 0, isDisqualified: true,
      },
      {
        sessionId: "s1", participantId: "p-UNKNOWN_GUID_2", position: 3, classPosition: 0, bestLapTime: undefined, totalTime: undefined, lapsCompleted: 0,
        status: "FINISHED", gap: undefined, points: 15, penaltyTime: undefined, lapPenalty: undefined, isDisqualified: false,
      },
    ])
    expect(console.warn).toHaveBeenCalledWith("Result entry for guid gZ / carId 9 has no matching participant.")

    // Laps in time order, numbered per driver; car 3's lap is Ana's
    expect(tx.raceLap.createMany).toHaveBeenCalledWith({
      data: [
        { sessionId: "s1", participantId: "p-gA", lapNumber: 1, lapTime: 103000, sector1: null, sector2: null, sector3: null, valid: false, cuts: 1, tyre: undefined, timestamp: 100 },
        { sessionId: "s1", participantId: "p-gB", lapNumber: 1, lapTime: 102000, sector1: 31000, sector2: 40000, sector3: 31000, valid: false, cuts: 2, tyre: "SM", timestamp: 150 },
        { sessionId: "s1", participantId: "p-gA", lapNumber: 2, lapTime: 101000, sector1: 30000, sector2: 40000, sector3: 31000, valid: true, cuts: 0, tyre: "SM", timestamp: 200 },
        { sessionId: "s1", participantId: "p-gA", lapNumber: 3, lapTime: 104000, sector1: null, sector2: null, sector3: null, valid: true, cuts: 0, tyre: undefined, timestamp: 300 },
      ],
    })

    // Collisions: Ana hit Ben (one each), then Ben hit a wall
    expect(tx.raceEvent.createMany).toHaveBeenCalledWith({
      data: [
        {
          sessionId: "s1", type: "COLLISION_WITH_CAR", carId: 0, driverGuid: "gA", participantId: "p-gA", otherCarId: 1, otherDriverGuid: "gB",
          otherParticipantId: "p-gB", impactSpeed: 12.5, worldPosX: 1, worldPosY: 2, worldPosZ: 3, relPosX: 0.1, relPosY: 0.2, relPosZ: 0.3,
        },
        {
          sessionId: "s1", type: "COLLISION_WITH_ENV", carId: 1, driverGuid: "gB", participantId: "p-gB", otherCarId: -1, otherDriverGuid: undefined,
          otherParticipantId: null, impactSpeed: 30, worldPosX: undefined, worldPosY: undefined, worldPosZ: undefined, relPosX: undefined, relPosY: undefined, relPosZ: undefined,
        },
      ],
    })

    // Backfills: laps and cuts per driver, then collisions
    expect(tx.raceResult.updateMany.mock.calls.map(([args]) => args)).toEqual([
      { where: { sessionId: "s1", participantId: "p-gA" }, data: { lapsCompleted: 3, totalCuts: 1 } },
      { where: { sessionId: "s1", participantId: "p-gB" }, data: { lapsCompleted: 1, totalCuts: 2 } },
      { where: { sessionId: "s1", participantId: "p-gA" }, data: { collisionCount: 1 } },
      { where: { sessionId: "s1", participantId: "p-gB" }, data: { collisionCount: 2 } },
    ])

    // The status and the audit entry are written in the same transaction
    expect(tx.rawResultUpload.update).toHaveBeenCalledWith({ where: { id: "up1" }, data: { status: "INGESTED" } })
    expect(audit.createAuditLog).toHaveBeenCalledWith(
      {
        actorUserId: "officer-1",
        actionType: "INGEST",
        entityType: "RESULT_UPLOAD",
        entityId: "up1",
        summary: "Ingested result upload up1 into event ev1",
        metadata: { eventId: "ev1", pointsSystem: "F1" },
      },
      tx,
    )
    expect(result).toEqual({
      ok: true,
      session: { id: "s1", eventId: "ev1" },
      counts: { participants: 3, results: 3, laps: 4, events: 2 },
      revalidate: ["/admin/results/up1", "/drivers", "/events/lsc-r3", "/events", "/lone-star-cup"],
    })
  })

  it("awards no points outside a race, and HALF points in a HALF race", async () => {
    stored({ pointsSystem: "NONE", sessionLabel: "QUALIFYING" })
    await ingestUpload("up1", officer)
    expect(tx.raceSession.create.mock.calls[0][0].data).toMatchObject({ sessionType: "QUALIFYING", pointsSystem: "NONE" })
    expect(tx.raceResult.create.mock.calls.map(([args]) => args.data.points)).toEqual([0, 0, 0])

    tx.raceResult.create.mockClear()
    stored({ pointsSystem: "HALF" })
    await ingestUpload("up1", officer)
    expect(tx.raceResult.create.mock.calls.map(([args]) => args.data.points)).toEqual([13, 9, 7.5])
  })

  it("defaults to an F1 race when the upload has no points system or label", async () => {
    stored({ pointsSystem: null, sessionLabel: null })
    await ingestUpload("up1", officer)
    expect(tx.raceSession.create.mock.calls[0][0].data).toMatchObject({ sessionType: "RACE", pointsSystem: "F1" })
    expect(tx.raceResult.create.mock.calls[0][0].data.points).toBe(25)
  })

  it("adds a proposal's ids to the audit entry", async () => {
    await ingestUpload("up1", viaJack)
    expect(audit.createAuditLog.mock.calls[0][0]).toMatchObject({ actorUserId: "officer-2", metadata: { via: "jack", proposalId: "p1", eventId: "ev1", pointsSystem: "F1" } })
  })

  it.each([
    ["the upload is gone", () => db.rawResultUpload.findUnique.mockResolvedValue(null), "That upload no longer exists. Go back to the results list."],
    ["it has no event", () => db.rawResultUpload.findUnique.mockResolvedValue(upload({ eventId: null })), "Link this upload to an event before ingesting it."],
    ["it's ingested", () => db.rawResultUpload.findUnique.mockResolvedValue(upload({ status: "INGESTED" })), ALREADY_INGESTED],
    ["it has race sessions", () => db.raceSession.count.mockResolvedValue(1), ALREADY_INGESTED],
    ["the file has no results", () => db.rawResultUpload.findUnique.mockResolvedValue(upload({ rawJson: { Laps: [] } })), "This file has no Result list, so there's nothing to ingest."],
  ])("refuses before the transaction when %s", async (_label, arrange, error) => {
    arrange()
    expect(await ingestUpload("up1", officer)).toEqual({ ok: false, error })
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  it("stops when another ingest got there first (checked again under the lock)", async () => {
    // The pre-check saw no sessions; the check under the lock finds the other ingest's
    tx.raceSession.count.mockResolvedValue(1)

    expect(await ingestUpload("up1", officer)).toEqual({ ok: false, error: ALREADY_INGESTED })
    expect(db.raceSession.count).toHaveBeenCalledTimes(1)
    expect(callOrder(tx.$queryRaw)).toBeLessThan(callOrder(tx.raceSession.count))
    expect(tx.raceSession.create).not.toHaveBeenCalled()
    expect(tx.rawResultUpload.update).not.toHaveBeenCalled()
    expect(audit.createAuditLog).not.toHaveBeenCalled()
  })

  it.each([
    ["the event", { eventId: "ev2", pointsSystem: "F1", sessionLabel: "RACE" }],
    ["the points system", { eventId: "ev1", pointsSystem: "HALF", sessionLabel: "RACE" }],
    ["the session label", { eventId: "ev1", pointsSystem: "F1", sessionLabel: "QUALIFYING" }],
    ["everything (the upload was deleted)", null],
  ])("stops when %s changed before the lock", async (_label, current) => {
    tx.rawResultUpload.findUnique.mockResolvedValue(current)
    expect(await ingestUpload("up1", officer)).toEqual({
      ok: false,
      error: "Someone changed this upload's event link while it was ingesting. Reload the page and try again.",
    })
    expect(callOrder(tx.$queryRaw)).toBeLessThan(callOrder(tx.rawResultUpload.findUnique))
    expect(tx.raceSession.create).not.toHaveBeenCalled()
    expect(audit.createAuditLog).not.toHaveBeenCalled()
  })

  it("throws other failures and writes no audit entry", async () => {
    tx.raceLap.createMany.mockRejectedValue(new Error("deadlock"))
    await expect(ingestUpload("up1", officer)).rejects.toThrow("deadlock")
    expect(tx.rawResultUpload.update).not.toHaveBeenCalled()
    expect(audit.createAuditLog).not.toHaveBeenCalled()
  })
})
