import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ $transaction: vi.fn(), user: { findMany: vi.fn() }, sponsorProspect: { findMany: vi.fn() } }))
const sponsors = vi.hoisted(() => ({ createProspectTx: vi.fn() }))
const meetings = vi.hoisted(() => ({ createActionItemTx: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/services/sponsor.service", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/services/sponsor.service")>()), ...sponsors }))
vi.mock("@/server/services/meeting.service", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/services/meeting.service")>()), ...meetings }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

import { IMPORT_TARGETS } from "../import-targets/sponsors-meetings"
import type { ProposalApplyContext } from "../types"
import { actionItemsImportTarget, officerFromCell, parseDateCell, prospectsImportTarget, resetImportCaches } from "./import-targets"

const audit = { via: "jack" as const, proposalId: "prop-1", roomId: "room-1", proposedFor: "u-ana" }
const ctx: ProposalApplyContext = { officer: { userId: "u-gray", displayName: "Gray" }, proposalId: "prop-1", roomId: "room-1", idempotencyKey: "proposal:prop-1", before: null, auditMetadata: audit }

const officers = [
  { id: "u-dylan", displayName: "Dylan Smith", handle: "dylan", email: "dylan@utexas.example" },
  { id: "u-sam", displayName: "Sam Lee", handle: "sam-l", email: null },
  { id: "u-sam2", displayName: "Sam Lee", handle: "sam-k", email: null },
]

beforeEach(() => {
  resetImportCaches()
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db))
  db.user.findMany.mockResolvedValue(officers)
  db.sponsorProspect.findMany.mockResolvedValue([{ company: "Apex Sim Rigs" }])
  sponsors.createProspectTx.mockImplementation(async (_tx, fields: { company: string }) => ({ ok: true, prospect: { id: `pr-${fields.company}`, company: fields.company }, changed: [] }))
  meetings.createActionItemTx.mockImplementation(async (_tx, fields: { text: string }) => ({ ok: true, item: { id: `ai-${fields.text.length}` }, changed: [] }))
})

it("registers both targets for import.rows", () => {
  expect(IMPORT_TARGETS.map((t) => t.target)).toEqual(["sponsor_prospects", "action_items"])
})

describe("cells", () => {
  it("reads dates as ISO, US-style or a timestamp", () => {
    expect(parseDateCell("2026-10-30")).toBe("2026-10-30")
    expect(parseDateCell("10/30/2026")).toBe("2026-10-30")
    expect(parseDateCell("1/5/27")).toBe("2027-01-05")
    expect(parseDateCell("2026-10-30T00:00:00.000Z")).toBe("2026-10-30")
    expect(parseDateCell("2026-02-30")).toBeNull()
    expect(parseDateCell("next Friday")).toBeNull()
  })

  it("finds an officer by handle, email or a name only one has", async () => {
    expect(await officerFromCell("@Dylan")).toMatchObject({ ok: true, officer: { id: "u-dylan" } })
    expect(await officerFromCell("DYLAN@utexas.example")).toMatchObject({ ok: true, officer: { id: "u-dylan" } })
    expect(await officerFromCell("dylan smith")).toMatchObject({ ok: true, officer: { id: "u-dylan" } })
    expect(await officerFromCell("Sam Lee")).toEqual({ ok: false, error: "2 officers are called Sam Lee; use a handle" })
    expect(await officerFromCell("Jordan")).toMatchObject({ ok: false, error: expect.stringMatching(/isn't an officer/) })
    // The list is read once for a burst of rows
    expect(db.user.findMany).toHaveBeenCalledTimes(1)
  })
})

describe("sponsor prospects", () => {
  it("checks a row into a prospect's fields", async () => {
    const check = await prospectsImportTarget.validateRow({ company: "Bolt Energy", website: "bolt.example", stage: "Talking", tierInterest: "Gold Partner", owner: "@dylan", nextStepDue: "11/2/2026", contactEmail: "SAM@BOLT.EXAMPLE" })
    expect(check).toMatchObject({
      ok: true,
      label: "Bolt Energy",
      value: { company: "Bolt Energy", website: "https://bolt.example/", stage: "talking", tierInterest: "gold", ownerId: "u-dylan", contactEmail: "sam@bolt.example", nextStepDue: new Date("2026-11-02T06:00:00Z") },
    })
  })

  it("refuses rows the import can't take, saying why", async () => {
    expect(await prospectsImportTarget.validateRow({ company: "" })).toMatchObject({ ok: false, error: "No company name" })
    expect(await prospectsImportTarget.validateRow({ company: "Bolt", stage: "warm" })).toMatchObject({ ok: false, error: expect.stringMatching(/Stage “warm”/) })
    expect(await prospectsImportTarget.validateRow({ company: "Bolt", tierInterest: "Diamond" })).toMatchObject({ ok: false, error: expect.stringMatching(/Tier “Diamond”/) })
    expect(await prospectsImportTarget.validateRow({ company: "Bolt", nextStepDue: "soon" })).toMatchObject({ ok: false, error: expect.stringMatching(/isn't a date/) })
    expect(await prospectsImportTarget.validateRow({ company: "Bolt", contactEmail: "nope" })).toMatchObject({ ok: false })
    expect(await prospectsImportTarget.validateRow({ company: "APEX SIM RIGS" })).toMatchObject({ ok: false, error: expect.stringMatching(/Already a prospect/) })
  })

  it("adds the picked rows, skipping a company twice in the file or added meanwhile", async () => {
    sponsors.createProspectTx.mockImplementation(async (_tx, fields: { company: string }) =>
      fields.company === "Crest" ? { ok: false, reason: "duplicate", error: "Crest is already a prospect." } : { ok: true, prospect: { id: `pr-${fields.company}`, company: fields.company }, changed: [] },
    )
    const value = (company: string) => ({ company, website: null, contactName: null, contactEmail: null, contactRole: null, stage: "idea" as const, tierInterest: null, ownerId: null, nextStep: null, nextStepDue: null, notes: null })
    const result = await prospectsImportTarget.applyRows(
      [
        { rowId: "r1", value: value("Bolt") },
        { rowId: "r2", value: value("bolt") },
        { rowId: "r3", value: value("Crest") },
      ],
      ctx,
    )
    expect(sponsors.createProspectTx.mock.calls.map((c) => c[2])).toEqual([
      { userId: "u-gray", auditMetadata: audit },
      { userId: "u-gray", auditMetadata: audit },
    ])
    expect(result).toMatchObject({ summary: "Added 1 sponsor prospect; skipped 2 companies already there (bolt, Crest).", appliedRows: ["r1"], counts: { added: 1, skipped: 2 } })
  })
})

describe("action items", () => {
  it("checks a row: text, an officer owner and a due date", async () => {
    expect(await actionItemsImportTarget.validateRow({ text: "Order banners", owner: "dylan", due: "2026-11-02" })).toMatchObject({
      ok: true,
      value: { text: "Order banners", ownerId: "u-dylan", dueAt: new Date("2026-11-02T06:00:00Z") },
      detail: "Dylan Smith · due 2026-11-02",
    })
    expect(await actionItemsImportTarget.validateRow({ text: "x" })).toMatchObject({ ok: false })
    expect(await actionItemsImportTarget.validateRow({ text: "Order banners", owner: "Jordan" })).toMatchObject({ ok: false })
  })

  it("adds the rows in the proposal's room, as the applying officer", async () => {
    const result = await actionItemsImportTarget.applyRows([{ rowId: "r1", value: { text: "Order banners", ownerId: null, dueAt: null } }], ctx)
    expect(meetings.createActionItemTx.mock.calls[0].slice(1)).toEqual([{ text: "Order banners", ownerId: null, dueAt: null }, { userId: "u-gray", auditMetadata: audit }, { roomId: "room-1" }])
    expect(result).toMatchObject({ summary: "Added 1 action item.", appliedRows: ["r1"] })
  })
})
