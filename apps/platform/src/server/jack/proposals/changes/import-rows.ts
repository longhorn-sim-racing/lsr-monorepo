import { z } from "zod"
import { prisma } from "@/server/db"
import { ProposalInputError, StaleProposalError } from "../errors"
import { findImportTarget, IMPORT_TARGETS } from "../import-targets"
import type { AnyImportTarget, ImportCells, ImportRowCheck, ProposalApplyContext, ProposalKind, ProposalRow } from "../types"
import { roomFile, type RoomFile } from "./room-file"
import { mapLimit, plural } from "./shared"
import { readTable, type Table } from "./table"

/**
 * import.rows (design §4.3): the rows of a spreadsheet or CSV attached in this room, put into the site
 * through an import target (proposals/import-targets: LSC entry forms here, prospects and action items
 * from the sponsors-meetings track). The model maps the file's columns onto the target's (`columnMap`);
 * `values` gives a column the same value on every row (the season, say).
 *
 * Propose reads the rows (the text G5 extracted at registration, ./table.ts), and the target checks
 * each one and finds what it refers to (validateRow, reads only): the card shows the rows that are ready,
 * picked, and the ones that can't go in, with why. Rows the target says are the same record (`key`) are
 * repeats: only the first is picked. Apply reads the file again (its sha256 is pinned), checks the picked
 * rows again and hands the ones still valid to the target. Who may apply it is the target's permission.
 */

/** Rows in one proposal; a longer file goes in several (fromRow) */
export const MAX_IMPORT_ROWS = 500

const TARGET_KEYS = IMPORT_TARGETS.map((t) => t.target)

const targetSchema = TARGET_KEYS.length ? z.enum(TARGET_KEYS as [string, ...string[]]) : z.string().trim().min(1).max(60)

export const importRowsSchema = z.object({
  fileId: z.string().trim().min(1).max(64).describe("The attached spreadsheet's or CSV's id"),
  target: targetSchema.describe("Where the rows go"),
  columnMap: z.record(z.string(), z.string().trim().min(1).max(200)).describe("For each target column (key), the header of the file's column that holds it, exactly as the file has it"),
  values: z.record(z.string(), z.string().trim().max(500)).optional().describe("For target columns the file doesn't have: one value for every row (e.g. the season)"),
  sheet: z.string().trim().min(1).max(120).optional().describe("For a spreadsheet with several sheets: the sheet's name (default: the first with rows)"),
  fromRow: z.number().int().min(1).max(100_000).optional().describe("The first data row to import (1 is the first under the header); one proposal takes up to 500 rows"),
})

export type ImportRows = z.infer<typeof importRowsSchema>

function targetLine(target: AnyImportTarget): string {
  const columns = target.columns.map((column) => `${column.key}${column.required ? "*" : ""}`).join(", ")
  return `${target.target} (${target.label}; columns ${columns})`
}

function describeTargets(): string {
  return IMPORT_TARGETS.length ? `Targets (* = required): ${IMPORT_TARGETS.map(targetLine).join("; ")}.` : "No targets are set up yet."
}

/** The file's table: its text, read the way registration saved it */
function tableOf(file: RoomFile, p: ImportRows, fail: (message: string) => Error): Table {
  if (!file.text || file.textStatus === "failed" || file.textStatus === "none") throw fail(`${file.filename}'s rows couldn't be read when it was attached.`)
  try {
    return readTable(file.text, { workbook: file.kind === "SPREADSHEET", sheet: p.sheet, filename: file.filename })
  } catch (error) {
    throw fail(error instanceof Error ? error.message : String(error))
  }
}

type MappedRow = { id: string; number: number; cells: ImportCells }

/** The file's rows as target cells, after the column map; throws `fail` for a map the file or target doesn't fit */
function mapRows(table: Table, target: AnyImportTarget, p: ImportRows, fail: (message: string) => Error): { rows: MappedRow[]; total: number; from: number } {
  const known = new Map(target.columns.map((column) => [column.key, column]))
  const headerIndex = new Map(table.headers.map((header, i) => [header.trim().toLowerCase(), i]))
  const columns: [string, number][] = []
  for (const [key, header] of Object.entries(p.columnMap)) {
    if (!known.has(key)) throw fail(`${target.label} has no column “${key}”. Its columns: ${target.columns.map((c) => c.key).join(", ")}.`)
    const index = headerIndex.get(header.trim().toLowerCase())
    if (index === undefined) throw fail(`The file has no column “${header}”${table.sheet ? ` in sheet “${table.sheet}”` : ""}. Its columns: ${table.headers.join(", ")}.`)
    columns.push([key, index])
  }
  for (const key of Object.keys(p.values ?? {})) {
    if (!known.has(key)) throw fail(`${target.label} has no column “${key}”. Its columns: ${target.columns.map((c) => c.key).join(", ")}.`)
    if (Object.hasOwn(p.columnMap, key)) throw fail(`“${key}” is in both columnMap and values; give it one way.`)
  }
  const missing = target.columns.filter((column) => column.required && !Object.hasOwn(p.columnMap, column.key) && !Object.hasOwn(p.values ?? {}, column.key))
  if (missing.length) throw fail(`${target.label} needs ${missing.map((c) => `${c.key} (${c.label})`).join(", ")}: map a file column to ${missing.length === 1 ? "it" : "each"}, or give it in values.`)

  const from = p.fromRow ?? 1
  if (from > Math.max(1, table.rows.length)) throw fail(`The file has ${plural(table.rows.length, "row")} under its header, so fromRow ${from} is past the end.`)
  const rows = table.rows.slice(from - 1, from - 1 + MAX_IMPORT_ROWS).map((cells, i) => {
    const number = from + i
    const mapped: ImportCells = { ...(p.values ?? {}) }
    for (const [key, index] of columns) mapped[key] = cells[index] ?? ""
    return { id: `r${number}`, number, cells: mapped }
  })
  return { rows, total: table.rows.length, from }
}

/** Each row checked by the target, a few at a time; a check that throws is the row's error */
async function checkRows(target: AnyImportTarget, rows: MappedRow[]): Promise<ImportRowCheck<unknown>[]> {
  return mapLimit(rows, 8, async (row) => {
    try {
      return await target.validateRow(row.cells)
    } catch (error) {
      console.error(`[jack] Import target ${target.target} couldn't check a row:`, error)
      return { ok: false as const, label: `Row ${row.number}`, error: "This row couldn't be checked." }
    }
  })
}

const savedBefore = z.object({ ready: z.array(z.string()), targetLabel: z.string() })

export const importRowsKind: ProposalKind<ImportRows> = {
  kind: "import.rows",
  tool: "propose_import",
  description: `import.rows: put the rows of a spreadsheet (.xlsx) or CSV attached in this room into the site. Map the file's columns onto the target's (columnMap: target column → the file's header, exactly); values gives a column one value for every row. The server checks every row; the card shows what's ready and what can't go in (and why), and officers untick rows. ${describeTargets()}`,
  schema: importRowsSchema,
  targetType: "IMPORT",
  permission: "officer",
  // An admin-only target makes the import admin-only; a target this site doesn't have can't be applied by anyone but an admin
  permissionFor(p) {
    const target = findImportTarget(p.target)
    return target ? (target.permission ?? "officer") : "admin"
  },

  async prepare(p, ctx) {
    const target = findImportTarget(p.target)
    if (!target) throw new ProposalInputError(`There's no import target “${p.target}”. ${describeTargets()}`)
    const file = await roomFile(p.fileId, ctx.roomId, ["CSV", "SPREADSHEET"], "a spreadsheet (.xlsx) or a CSV file")
    const fail = (message: string) => new ProposalInputError(message)
    const table = tableOf(file, p, fail)
    const { rows, total, from } = mapRows(table, target, p, fail)
    if (!rows.length) throw new ProposalInputError(`${file.filename} has no rows under its header.`)

    const checks = await checkRows(target, rows)
    const view: ProposalRow[] = []
    const firstOf = new Map<string, number>()
    let ready = 0
    let repeats = 0
    let refused = 0
    for (const [i, check] of checks.entries()) {
      const row = rows[i]
      if (!check.ok) {
        refused++
        view.push({ id: row.id, label: `Row ${row.number}: ${check.label}`, detail: check.error, status: "unmatched" })
        continue
      }
      const earlier = check.key ? firstOf.get(check.key) : undefined
      if (earlier !== undefined) {
        repeats++
        view.push({ id: row.id, label: `Row ${row.number}: ${check.label}`, detail: `Repeats row ${earlier}${check.detail ? `: ${check.detail}` : ""}`, status: "ambiguous" })
        continue
      }
      if (check.key) firstOf.set(check.key, row.number)
      ready++
      view.push({ id: row.id, label: `Row ${row.number}: ${check.label}`, ...(check.detail ? { detail: check.detail } : {}), status: check.status ?? "matched" })
    }

    if (!ready) {
      const reasons = view.slice(0, 5).map((r) => `${r.label}: ${r.detail ?? "can't go in"}`)
      throw new ProposalInputError(`None of the ${plural(rows.length, "row")} can go in, so there's nothing to propose. ${reasons.join("; ")}${view.length > 5 ? "; …" : ""}`)
    }

    const last = from + rows.length - 1
    const where = `${file.filename}${table.sheet ? ` (sheet “${table.sheet}”)` : ""}`
    const sentences = [
      `Applying it adds the ticked rows from ${where} to ${target.label}.`,
      [`${plural(ready, "row is", "rows are")} ready`, refused ? `${plural(refused, "row")} can't go in (the reason is on each)` : null, repeats ? `${plural(repeats, "row repeats", "rows repeat")} an earlier one` : null].filter(Boolean).join(", ") + ".",
      total > last || from > 1 ? `This covers rows ${from} to ${last} of ${total}${total > last ? `; rows from ${last + 1} on need another proposal (fromRow ${last + 1})` : ""}.` : null,
      file.textStatus === "truncated" || file.textStatus === "timeout" ? `Only the first part of the file could be read when it was attached (5,000 rows at most), so later rows aren't here.` : null,
    ].filter(Boolean)
    return {
      before: { ready: view.filter((r) => r.status === "matched").map((r) => r.id), targetLabel: target.label },
      targetId: `${file.id}:${target.target}:${from}`,
      fileSha256: file.sha256,
      view: { title: `Import ${plural(rows.length, "row")} into ${target.label}`, summary: sentences.join(" "), diff: [], rows: view },
    }
  },

  async checkStale(p, before) {
    const saved = savedBefore.safeParse(before)
    if (!saved.success) return "The proposal's copy is missing. Ask Jack to propose it again."
    return findImportTarget(p.target) ? null : `This site can't import into ${saved.data.targetLabel} any more.`
  },

  async apply(p, ctx: ProposalApplyContext) {
    const saved = savedBefore.safeParse(ctx.before)
    if (!saved.success) throw new StaleProposalError("The proposal's copy is missing. Ask Jack to propose it again.")
    const target = findImportTarget(p.target)
    if (!target) throw new StaleProposalError(`This site can't import into ${saved.data.targetLabel} any more.`)
    const row = await prisma.jackFile.findUnique({ where: { id: p.fileId }, select: { id: true, roomId: true, filename: true, kind: true, status: true, sha256: true, sizeBytes: true, storagePath: true, text: true, textStatus: true } })
    if (!row || row.roomId !== ctx.roomId) throw new StaleProposalError("The file it was built from was deleted.")
    const fail = (message: string) => new StaleProposalError(`The file no longer reads the same: ${message}`)
    const { rows } = mapRows(tableOf(row, p, fail), target, p, fail)

    const picked = new Set(ctx.selectedRows ?? saved.data.ready)
    const chosen = rows.filter((r) => picked.has(r.id))
    const checks = await checkRows(target, chosen)
    const valid: { rowId: string; value: unknown }[] = []
    const seen = new Set<string>()
    let skipped = 0
    for (const [i, check] of checks.entries()) {
      if (!check.ok || (check.key && seen.has(check.key))) {
        skipped++
        continue
      }
      if (check.key) seen.add(check.key)
      valid.push({ rowId: chosen[i].id, value: check.value })
    }
    if (!valid.length) throw new Error(`None of the ticked rows can go in now${skipped ? `: ${skipped === 1 ? "it no longer passes the checks or repeats another row" : "they no longer pass the checks or repeat other rows"}` : ""}.`)

    const result = await target.applyRows(valid, ctx)
    const note = skipped ? ` ${plural(skipped, "ticked row")} no longer passed the checks and ${skipped === 1 ? "was" : "were"} left out.` : ""
    return { ...result, summary: `${result.summary}${note}`, appliedRows: result.appliedRows ?? valid.map((v) => v.rowId) }
  },
}
