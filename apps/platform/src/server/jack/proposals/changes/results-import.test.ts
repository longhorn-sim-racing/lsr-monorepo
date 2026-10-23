import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  jackFile: { findUnique: vi.fn() },
  event: { findUnique: vi.fn() },
  rawResultUpload: { findFirst: vi.fn() },
  raceSession: { count: vi.fn() },
  driverIdentity: { findMany: vi.fn() },
}))
const results = vi.hoisted(() => ({ previewResultFile: vi.fn(), createUpload: vi.fn(), parseUpload: vi.fn(), bindUpload: vi.fn(), ingestUpload: vi.fn() }))
const store = vi.hoisted(() => ({ get: vi.fn() }))
const cache = vi.hoisted(() => ({ revalidatePaths: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/services/results.service", () => results)
vi.mock("@/server/jack/decks/storage", () => ({ jackFileStore: () => store }))
vi.mock("@/server/cache/revalidate-public", () => cache)

import { ProposalInputError, StaleProposalError } from "../errors"
import type { ProposalApplyContext, ProposalContext } from "../types"
import { resultsImportKind, resultsImportSchema, type ResultsImport } from "./results-import"

const FILE_JSON = JSON.stringify({ TrackName: "spa", Type: "RACE", Date: "2026-10-17T00:30:00Z", Result: [], Laps: [] })
const BYTES = Buffer.from(FILE_JSON)
const SHA = createHash("sha256").update(BYTES).digest("hex")
const FILE = { id: "f1", roomId: "room-1", filename: "round3-race.json", kind: "JSON", status: "READY", sha256: SHA, sizeBytes: BYTES.length, storagePath: "rooms/room-1/f1/round3-race.json", text: "{}", textStatus: "ok" }

const ctx: ProposalContext = { roomId: "room-1", messageId: "reply-1", officer: { userId: "u1", displayName: "Ana" } }
const meta = { via: "jack" as const, proposalId: "prop-1", roomId: "room-1", proposedFor: "u1" }
const applyCtx = (before: unknown): ProposalApplyContext => ({ officer: { userId: "u2", displayName: "Gray" }, proposalId: "prop-1", roomId: "room-1", idempotencyKey: "proposal:prop-1", before, auditMetadata: meta })
const actor = { userId: "u2", auditMetadata: meta }
const payload = (p: Record<string, unknown> = {}) => resultsImportSchema.parse({ fileId: "f1", eventId: "ev-3", sessionLabel: "RACE", ...p }) as ResultsImport

beforeEach(() => {
  db.jackFile.findUnique.mockResolvedValue(FILE)
  db.event.findUnique.mockResolvedValue({ id: "ev-3", title: "LSC Round 3 @ Spa", startsAtUtc: new Date("2026-10-17T00:00:00Z"), slug: "lsc-round-3" })
  db.rawResultUpload.findFirst.mockResolvedValue(null)
  db.raceSession.count.mockResolvedValue(0)
  db.driverIdentity.findMany.mockResolvedValue([{ driverGuid: "g1", user: { displayName: "Ana Torres" } }])
  store.get.mockResolvedValue(BYTES)
  results.previewResultFile.mockResolvedValue({
    ok: true,
    status: "PARSED",
    report: { drivers: [{ guid: "g1", driverName: "Ana T", carModel: "bmw" }, { guid: "g2", driverName: "Racer X", carModel: "bmw" }], resultsCount: 2, lapsCount: 40, anomalies: [] },
    unmatchedDrivers: [{ guid: "g2", driverName: "Racer X", carModel: "bmw" }],
  })
  results.createUpload.mockResolvedValue({ ok: true, upload: { id: "up-1", status: "UPLOADED" }, revalidate: ["/admin/results"] })
  results.parseUpload.mockResolvedValue({ ok: true, upload: { id: "up-1", status: "PARSED" }, report: {}, unmatchedDrivers: [], revalidate: ["/admin/results/up-1", "/admin/results"] })
  results.bindUpload.mockResolvedValue({ ok: true, upload: {}, revalidate: ["/admin/results/up-1"] })
  results.ingestUpload.mockResolvedValue({ ok: true, session: { id: "rs-1", eventId: "ev-3" }, counts: { participants: 2, results: 2, laps: 40, events: 3 }, revalidate: ["/admin/results/up-1", "/drivers", "/events/lsc-round-3", "/events", "/lone-star-cup"] })
})

describe("results.import: prepare", () => {
  it("runs the pure parse on the room file and shows the drivers, with the file pinned", async () => {
    const prepared = await resultsImportKind.prepare(payload(), ctx)
    expect(results.previewResultFile).toHaveBeenCalledWith(JSON.parse(FILE_JSON))
    expect(prepared).toMatchObject({ targetId: "file:f1", fileSha256: SHA, before: { eventTitle: "LSC Round 3 @ Spa" } })
    expect(prepared.view.title).toBe("Import race results into “LSC Round 3 @ Spa”")
    expect(prepared.view.summary).toBe(
      "Applying it uploads round3-race.json, links it to “LSC Round 3 @ Spa” as the race with F1 points, and creates the session's records: 2 drivers, 2 results, 40 laps. The file: spa, race, Fri Oct 16, 7:30 PM CT. 1 driver isn't linked to a member (Racer X), so their points don't count in standings until they're mapped on Driver mapping. Standings aren't recomputed; do that on the season page.",
    )
    expect(prepared.view.people).toEqual([{ name: "Ana T", detail: "Ana Torres" }, { name: "Racer X", detail: "not linked to a member" }])
    expect(prepared.view.links).toEqual([
      { title: "Results", url: "/admin/results" },
      { title: "Event", url: "/admin/events/ev-3/edit" },
      { title: "Driver mapping", url: "/admin/drivers" },
    ])
  })

  it("says when the session or points look off", async () => {
    const qualifying = await resultsImportKind.prepare(payload({ sessionLabel: "QUALIFYING", pointsSystem: "F1" }), ctx)
    expect(qualifying.view.summary).toContain("as the qualifying with no points")
    expect(qualifying.view.summary).toContain("Heads up: the file says it's race, not qualifying.")
    expect(qualifying.view.summary).toContain("Qualifying never awards points.")
    db.raceSession.count.mockResolvedValue(1)
    expect((await resultsImportKind.prepare(payload(), ctx)).view.summary).toContain("“LSC Round 3 @ Spa” already has 1 race session ingested; this adds another.")
  })

  it("refuses another room's file, the wrong kind of file, a file that isn't results and one already imported", async () => {
    const refused = async (message: RegExp | string) => {
      const error = await resultsImportKind.prepare(payload(), ctx).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ProposalInputError)
      expect((error as Error).message).toMatch(message)
    }
    db.rawResultUpload.findFirst.mockResolvedValue({ id: "up-0", event: { title: "LSC Round 2" } })
    await refused("This exact file is already imported for “LSC Round 2” (/admin/results/up-0)")
    db.rawResultUpload.findFirst.mockResolvedValue(null)
    results.previewResultFile.mockResolvedValue({ ok: false, error: "This file isn't a results file: it has no session data." })
    await refused("round3-race.json: This file isn't a results file")
    store.get.mockResolvedValue(Buffer.from("not json"))
    await refused(/isn't the file that was attached|isn't valid JSON/)
    db.jackFile.findUnique.mockResolvedValue({ ...FILE, kind: "PDF" })
    await refused("round3-race.json is a PDF; this needs the results .json file the sim server saved.")
    db.jackFile.findUnique.mockResolvedValue({ ...FILE, roomId: "other-room" })
    await refused("There's no file f1 in this room.")
    db.jackFile.findUnique.mockResolvedValue({ ...FILE, status: "UPLOADING" })
    await refused("still uploading")
  })
})

describe("results.import: apply", () => {
  it("uploads, parses, links and ingests through the results service, as the applying officer", async () => {
    const result = await resultsImportKind.apply(payload({ pointsSystem: "HALF" }), applyCtx({ eventTitle: "LSC Round 3 @ Spa" }))
    expect(results.createUpload).toHaveBeenCalledWith({ filename: "round3-race.json", bytes: expect.any(ArrayBuffer) }, actor)
    expect(new TextDecoder().decode(results.createUpload.mock.calls[0][0].bytes)).toBe(FILE_JSON)
    expect(results.parseUpload).toHaveBeenCalledWith("up-1", { write: true, actor })
    expect(results.bindUpload).toHaveBeenCalledWith({ uploadId: "up-1", eventId: "ev-3", pointsSystem: "HALF", sessionLabel: "RACE" }, actor)
    expect(results.ingestUpload).toHaveBeenCalledWith("up-1", actor)
    expect(cache.revalidatePaths).toHaveBeenCalledWith(["/admin/results", "/admin/results/up-1", "/drivers", "/events/lsc-round-3", "/events", "/lone-star-cup"])
    expect(result).toEqual({
      summary: "Imported the race results into “LSC Round 3 @ Spa”: 2 results, 40 laps.",
      links: [
        { title: "Upload", url: "/admin/results/up-1" },
        { title: "Event page", url: "/events/lsc-round-3" },
      ],
      created: [
        { type: "RESULT_UPLOAD", id: "up-1" },
        { type: "RACE_SESSION", id: "rs-1" },
      ],
      counts: { participants: 2, results: 2, laps: 40, events: 3 },
    })
  })

  it("never awards practice or qualifying points", async () => {
    await resultsImportKind.apply(payload({ sessionLabel: "PRACTICE", pointsSystem: "F1" }), applyCtx({ eventTitle: "x" }))
    expect(results.bindUpload).toHaveBeenCalledWith(expect.objectContaining({ pointsSystem: "NONE", sessionLabel: "PRACTICE" }), actor)
  })

  it("says where the upload stopped when a step fails, and goes stale when the stored file changed", async () => {
    results.ingestUpload.mockResolvedValue({ ok: false, error: "Someone changed this upload's event link while it was ingesting. Reload the page and try again." })
    await expect(resultsImportKind.apply(payload(), applyCtx({ eventTitle: "x" }))).rejects.toThrow(
      "Someone changed this upload's event link while it was ingesting. Reload the page and try again. The upload stopped at “ingest”: finish or delete it at /admin/results/up-1.",
    )
    store.get.mockResolvedValue(Buffer.from("{}"))
    await expect(resultsImportKind.apply(payload(), applyCtx({ eventTitle: "x" }))).rejects.toBeInstanceOf(StaleProposalError)
    db.jackFile.findUnique.mockResolvedValue(null)
    await expect(resultsImportKind.apply(payload(), applyCtx({ eventTitle: "x" }))).rejects.toThrow("The file it was built from was deleted.")
  })

  it("goes stale when the event is gone or the file was imported since", async () => {
    expect(await resultsImportKind.checkStale(payload(), { eventTitle: "LSC Round 3 @ Spa" })).toBeNull()
    db.rawResultUpload.findFirst.mockResolvedValue({ id: "up-0", event: null })
    expect(await resultsImportKind.checkStale(payload(), { eventTitle: "LSC Round 3 @ Spa" })).toBe("This file was imported since this was proposed (/admin/results/up-0).")
    db.event.findUnique.mockResolvedValue(null)
    expect(await resultsImportKind.checkStale(payload(), { eventTitle: "LSC Round 3 @ Spa" })).toBe("The event “LSC Round 3 @ Spa” was deleted.")
  })
})
