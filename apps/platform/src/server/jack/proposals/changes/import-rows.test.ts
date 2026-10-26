import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ jackFile: { findUnique: vi.fn() } }))
const target = vi.hoisted(() => ({
  target: "contacts",
  label: "Contacts",
  columns: [
    { key: "email", label: "Email", required: true },
    { key: "name", label: "Name" },
    { key: "team", label: "Team" },
  ],
  validateRow: vi.fn(),
  applyRows: vi.fn(),
}))
const admin = vi.hoisted(() => ({ ...target, target: "secrets", label: "Secrets", permission: "admin" as const }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("../import-targets", () => ({ IMPORT_TARGETS: [target, admin], findImportTarget: (key: string) => [target, admin].find((t) => t.target === key) }))

import { ProposalInputError, StaleProposalError } from "../errors"
import type { ImportCells, ProposalApplyContext, ProposalContext } from "../types"
import { importRowsKind, importRowsSchema, type ImportRows } from "./import-rows"

const CSV = "Full name,E-mail,Squad\nAna Torres,ana@example.com,Media\nBen Ito,,Tech\nCy Park,cy@example.com,Tech\nAna again,ANA@example.com,Media\n"
const FILE = { id: "f1", roomId: "room-1", filename: "contacts.csv", kind: "CSV", status: "READY", sha256: "sha-1", sizeBytes: 100, storagePath: "rooms/room-1/f1/contacts.csv", text: CSV, textStatus: "ok" }

const ctx: ProposalContext = { roomId: "room-1", messageId: "reply-1", officer: { userId: "u1", displayName: "Ana" } }
const meta = { via: "jack" as const, proposalId: "prop-1", roomId: "room-1", proposedFor: "u1" }
const applyCtx = (before: unknown, selectedRows?: string[]): ProposalApplyContext => ({ officer: { userId: "u2", displayName: "Gray" }, proposalId: "prop-1", roomId: "room-1", idempotencyKey: "proposal:prop-1", before, auditMetadata: meta, selectedRows })
const payload = (p: Record<string, unknown> = {}) => importRowsSchema.parse({ fileId: "f1", target: "contacts", columnMap: { email: "E-mail", name: "full name" }, values: { team: "Media" }, ...p }) as ImportRows

beforeEach(() => {
  db.jackFile.findUnique.mockResolvedValue(FILE)
  target.validateRow.mockImplementation(async (row: ImportCells) =>
    row.email ? { ok: true, value: { email: row.email.toLowerCase(), team: row.team }, label: row.name, detail: `${row.email} · ${row.team}`, key: row.email.toLowerCase() } : { ok: false, label: row.name, error: "No email." },
  )
  target.applyRows.mockImplementation(async (rows: { rowId: string }[]) => ({ summary: `Added ${rows.length} contacts.`, links: [{ title: "Contacts", url: "/admin/contacts" }] }))
})

describe("import.rows: prepare", () => {
  it("maps the file's columns, checks every row with the target and marks repeats", async () => {
    const prepared = await importRowsKind.prepare(payload(), ctx)
    expect(target.validateRow.mock.calls.map(([row]) => row)).toEqual([
      { team: "Media", email: "ana@example.com", name: "Ana Torres" },
      { team: "Media", email: "", name: "Ben Ito" },
      { team: "Media", email: "cy@example.com", name: "Cy Park" },
      { team: "Media", email: "ANA@example.com", name: "Ana again" },
    ])
    expect(prepared.view.rows).toEqual([
      { id: "r1", label: "Row 1: Ana Torres", detail: "ana@example.com · Media", status: "matched" },
      { id: "r2", label: "Row 2: Ben Ito", detail: "No email.", status: "unmatched" },
      { id: "r3", label: "Row 3: Cy Park", detail: "cy@example.com · Media", status: "matched" },
      { id: "r4", label: "Row 4: Ana again", detail: "Repeats row 1: ANA@example.com · Media", status: "ambiguous" },
    ])
    expect(prepared).toMatchObject({ before: { ready: ["r1", "r3"], targetLabel: "Contacts" }, targetId: "f1:contacts:1", fileSha256: "sha-1" })
    expect(prepared.view.title).toBe("Import 4 rows into Contacts")
    expect(prepared.view.summary).toBe("Applying it adds the ticked rows from contacts.csv to Contacts. 2 rows are ready, 1 row can't go in (the reason is on each), 1 row repeats an earlier one.")
  })

  it("explains a column map the file or the target doesn't fit", async () => {
    await expect(importRowsKind.prepare(payload({ columnMap: { email: "Mail" } }), ctx)).rejects.toThrow("The file has no column “Mail”. Its columns: Full name, E-mail, Squad.")
    await expect(importRowsKind.prepare(payload({ columnMap: { email: "E-mail", phone: "Squad" } }), ctx)).rejects.toThrow("Contacts has no column “phone”. Its columns: email, name, team.")
    await expect(importRowsKind.prepare(payload({ columnMap: { name: "Full name" } }), ctx)).rejects.toThrow("Contacts needs email (Email): map a file column to it, or give it in values.")
    await expect(importRowsKind.prepare(payload({ columnMap: { email: "E-mail", team: "Squad" }, values: { team: "x" } }), ctx)).rejects.toThrow("“team” is in both columnMap and values")
    await expect(importRowsKind.prepare(payload({ fromRow: 9 }), ctx)).rejects.toThrow("The file has 4 rows under its header, so fromRow 9 is past the end.")
    db.jackFile.findUnique.mockResolvedValue({ ...FILE, kind: "PDF" })
    await expect(importRowsKind.prepare(payload(), ctx)).rejects.toBeInstanceOf(ProposalInputError)
    db.jackFile.findUnique.mockResolvedValue({ ...FILE, text: null, textStatus: "failed" })
    await expect(importRowsKind.prepare(payload(), ctx)).rejects.toThrow("contacts.csv's rows couldn't be read when it was attached.")
  })

  it("proposes nothing when no row can go in, and says why", async () => {
    target.validateRow.mockResolvedValue({ ok: false, label: "Someone", error: "No account." })
    await expect(importRowsKind.prepare(payload(), ctx)).rejects.toThrow("None of the 4 rows can go in, so there's nothing to propose. Row 1: Someone: No account.; Row 2: Someone: No account.")
  })

  it("takes a slice of a long file, and says what's left", async () => {
    const prepared = await importRowsKind.prepare(payload({ fromRow: 3 }), ctx)
    expect(prepared.view.rows?.map((r) => r.id)).toEqual(["r3", "r4"])
    expect(prepared.targetId).toBe("f1:contacts:3")
    expect(prepared.view.summary).toContain("This covers rows 3 to 4 of 4.")
  })

  it("asks for the target's permission, and an admin for one it doesn't know", () => {
    expect(importRowsKind.permissionFor!(payload())).toBe("officer")
    expect(importRowsKind.permissionFor!({ ...payload(), target: "secrets" })).toBe("admin")
    expect(importRowsKind.permissionFor!({ ...payload(), target: "gone" })).toBe("admin")
  })
})

describe("import.rows: apply", () => {
  const before = { ready: ["r1", "r3"], targetLabel: "Contacts" }

  it("checks the picked rows again and hands the valid ones to the target", async () => {
    const result = await importRowsKind.apply(payload(), applyCtx(before, ["r1", "r2", "r4"]))
    expect(target.applyRows).toHaveBeenCalledWith([{ rowId: "r1", value: { email: "ana@example.com", team: "Media" } }], expect.objectContaining({ proposalId: "prop-1", auditMetadata: meta }))
    expect(result).toEqual({
      summary: "Added 1 contacts. 2 ticked rows no longer passed the checks and were left out.",
      links: [{ title: "Contacts", url: "/admin/contacts" }],
      appliedRows: ["r1"],
    })
  })

  it("applies the ready rows when none were picked, and refuses when none can go in", async () => {
    await importRowsKind.apply(payload(), applyCtx(before))
    expect(target.applyRows).toHaveBeenLastCalledWith(
      [
        { rowId: "r1", value: expect.anything() },
        { rowId: "r3", value: expect.anything() },
      ],
      expect.anything(),
    )
    await expect(importRowsKind.apply(payload(), applyCtx(before, ["r2"]))).rejects.toThrow("None of the ticked rows can go in now: it no longer passes the checks or repeats another row.")
  })

  it("goes stale when the file can't be read the same way or the target is gone", async () => {
    db.jackFile.findUnique.mockResolvedValue({ ...FILE, text: "Other,Columns\n1,2\n" })
    await expect(importRowsKind.apply(payload(), applyCtx(before))).rejects.toBeInstanceOf(StaleProposalError)
    db.jackFile.findUnique.mockResolvedValue(null)
    await expect(importRowsKind.apply(payload(), applyCtx(before))).rejects.toThrow("The file it was built from was deleted.")
    expect(await importRowsKind.checkStale({ ...payload(), target: "gone" }, before)).toBe("This site can't import into Contacts any more.")
  })
})
