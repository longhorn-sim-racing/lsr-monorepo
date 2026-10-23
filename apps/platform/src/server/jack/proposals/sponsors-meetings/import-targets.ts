import { ACTION_ITEMS_PAGE, dueDateValue } from "@/lib/meetings"
import { companyKey, parseProspectStage, parseTier, SPONSORS_PAGE } from "@/lib/sponsor-prospects"
import { actionItemFieldsSchema, type ActionItemFields } from "@/schemas/meeting.schema"
import { prospectFieldsSchema, type ProspectFields } from "@/schemas/sponsor-prospect.schema"
import { prisma } from "@/server/db"
import { actionItemPaths, createActionItemTx } from "@/server/services/meeting.service"
import { OFFICER_WHERE } from "@/server/services/officers"
import { createProspectTx, prospectPaths } from "@/server/services/sponsor.service"
import { isCalendarDate, startOfCentralDay } from "../../tools/time"
import type { ImportCells, ImportRowCheck, ImportTarget } from "../types"
import { clip, plural, revalidateQuietly } from "./shared"

/**
 * Where an import.rows proposal (changes track) can put a spreadsheet's rows, from the sponsors-meetings
 * track (design §4.3): sponsor prospects and action items. import.rows reads the room file, maps its
 * columns onto these, calls validateRow for each row (at propose time and again at apply) and hands the
 * valid, picked rows to applyRows. Both go through the same services as the admin pages.
 */

/** "2026-10-30", "10/30/2026", "10/30/26" or an ISO timestamp → "2026-10-30"; null when it isn't a date */
export function parseDateCell(text: string): string | null {
  const value = text.trim()
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[T ][\d:.]+Z?)?$/.exec(value)
  if (iso) return isCalendarDate(iso[1]) ? iso[1] : null
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(value)
  if (!us) return null
  const year = us[3].length === 2 ? `20${us[3]}` : us[3]
  const day = `${year}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`
  return isCalendarDate(day) ? day : null
}

type OfficerCell = { id: string; displayName: string; handle: string; email: string | null }

/** Officers, cached for a few seconds: validateRow runs once per row, and the list is small */
let officerCache: { at: number; officers: OfficerCell[] } | null = null
const OFFICER_CACHE_MS = 10_000

async function officers(): Promise<OfficerCell[]> {
  if (officerCache && Date.now() - officerCache.at < OFFICER_CACHE_MS) return officerCache.officers
  const rows = await prisma.user.findMany({ where: OFFICER_WHERE, select: { id: true, displayName: true, handle: true, email: true } })
  officerCache = { at: Date.now(), officers: rows }
  return rows
}

/** The prospects' company keys, cached the same way (applyRows checks again, under the service's duplicate check) */
let companyCache: { at: number; keys: Set<string> } | null = null

async function prospectCompanies(): Promise<Set<string>> {
  if (companyCache && Date.now() - companyCache.at < OFFICER_CACHE_MS) return companyCache.keys
  const rows = await prisma.sponsorProspect.findMany({ select: { company: true } })
  companyCache = { at: Date.now(), keys: new Set(rows.map((row) => companyKey(row.company))) }
  return companyCache.keys
}

/** Clears the caches (tests) */
export function resetImportCaches() {
  officerCache = null
  companyCache = null
}

/** An officer from a cell: their handle ("@dylan" or "dylan"), email, or exact name when only one officer has it */
export async function officerFromCell(cell: string): Promise<{ ok: true; officer: OfficerCell } | { ok: false; error: string }> {
  const value = cell.trim()
  const lower = value.toLowerCase().replace(/^@/, "")
  const list = await officers()
  const byHandle = list.find((o) => o.handle.toLowerCase() === lower)
  if (byHandle) return { ok: true, officer: byHandle }
  const byEmail = list.find((o) => o.email?.toLowerCase() === value.toLowerCase())
  if (byEmail) return { ok: true, officer: byEmail }
  const byName = list.filter((o) => o.displayName.toLowerCase() === value.toLowerCase())
  if (byName.length === 1) return { ok: true, officer: byName[0] }
  if (byName.length > 1) return { ok: false, error: `${byName.length} officers are called ${value}; use a handle` }
  return { ok: false, error: `${clip(value, 40)} isn't an officer (use a handle or email)` }
}

const cell = (row: ImportCells, key: string) => (row[key] ?? "").trim()

export const prospectsImportTarget: ImportTarget<ProspectFields> = {
  target: "sponsor_prospects",
  label: "Sponsor prospects",
  columns: [
    { key: "company", label: "Company", required: true },
    { key: "website", label: "Website" },
    { key: "contactName", label: "Contact name" },
    { key: "contactEmail", label: "Contact email" },
    { key: "contactRole", label: "Contact's role", description: "e.g. Marketing manager" },
    { key: "stage", label: "Stage", description: "idea, researching, contacted, talking, committed, declined or dormant (default idea)" },
    { key: "tierInterest", label: "Tier interest", description: "Friend, Silver, Gold or Platinum" },
    { key: "owner", label: "Owner", description: "The officer handling it: handle, email or name" },
    { key: "nextStep", label: "Next step" },
    { key: "nextStepDue", label: "Next step due", description: "A date" },
    { key: "notes", label: "Notes" },
  ],

  async validateRow(row): Promise<ImportRowCheck<ProspectFields>> {
    const company = cell(row, "company")
    const label = company || "(no company)"
    if (!company) return { ok: false, label, error: "No company name" }
    const stageText = cell(row, "stage")
    const stage = stageText ? parseProspectStage(stageText) : "idea"
    if (!stage) return { ok: false, label, error: `Stage “${clip(stageText, 30)}” isn't one of idea, researching, contacted, talking, committed, declined, dormant` }
    const tierText = cell(row, "tierInterest")
    const tier = tierText ? parseTier(tierText) : null
    if (tierText && !tier) return { ok: false, label, error: `Tier “${clip(tierText, 30)}” isn't Friend, Silver, Gold or Platinum` }
    const ownerText = cell(row, "owner")
    const owner = ownerText ? await officerFromCell(ownerText) : null
    if (owner && !owner.ok) return { ok: false, label, error: owner.error }
    const dueText = cell(row, "nextStepDue")
    const due = dueText ? parseDateCell(dueText) : null
    if (dueText && !due) return { ok: false, label, error: `Next step due “${clip(dueText, 30)}” isn't a date` }

    const parsed = prospectFieldsSchema.safeParse({
      company,
      website: cell(row, "website"),
      contactName: cell(row, "contactName"),
      contactEmail: cell(row, "contactEmail"),
      contactRole: cell(row, "contactRole"),
      stage,
      tierInterest: tier,
      ownerId: owner?.ok ? owner.officer.id : null,
      nextStep: cell(row, "nextStep"),
      nextStepDue: due ? startOfCentralDay(due) : null,
      notes: cell(row, "notes"),
    })
    if (!parsed.success) return { ok: false, label, error: parsed.error.issues[0]?.message ?? "Check the row" }
    if ((await prospectCompanies()).has(companyKey(company))) return { ok: false, label, error: "Already a prospect (change it on its Sponsors page, or with prospect.upsert)" }
    const detail = [parsed.data.stage, owner?.ok ? owner.officer.displayName : null, parsed.data.contactName].filter(Boolean).join(" · ")
    return { ok: true, value: parsed.data, label, ...(detail ? { detail } : {}) }
  },

  async applyRows(rows, ctx) {
    const actor = { userId: ctx.officer.userId, auditMetadata: ctx.auditMetadata }
    const result = await prisma.$transaction(
      async (tx) => {
        const created: { rowId: string; id: string }[] = []
        const skipped: string[] = []
        const seen = new Set<string>()
        for (const { rowId, value } of rows) {
          // The same company twice in the file, or added since it was checked: keep the first
          const key = companyKey(value.company)
          if (seen.has(key)) {
            skipped.push(value.company)
            continue
          }
          seen.add(key)
          const saved = await createProspectTx(tx, value, actor)
          if (!saved.ok) {
            if (saved.reason === "duplicate") {
              skipped.push(value.company)
              continue
            }
            throw new Error(`${value.company}: ${saved.error}`)
          }
          created.push({ rowId, id: saved.prospect.id })
        }
        return { created, skipped }
      },
      { timeout: 60_000 },
    )
    revalidateQuietly(prospectPaths())
    return {
      summary: `Added ${plural(result.created.length, "sponsor prospect")}${result.skipped.length ? `; skipped ${plural(result.skipped.length, "company", "companies")} already there (${clip(result.skipped.join(", "), 120)})` : ""}.`,
      links: [{ title: "Sponsors", url: SPONSORS_PAGE }],
      created: result.created.map((row) => ({ type: "SPONSOR_PROSPECT", id: row.id })),
      appliedRows: result.created.map((row) => row.rowId),
      counts: { added: result.created.length, skipped: result.skipped.length },
    }
  },
}

export const actionItemsImportTarget: ImportTarget<ActionItemFields> = {
  target: "action_items",
  label: "Action items",
  columns: [
    { key: "text", label: "Action item", required: true, description: "What needs doing" },
    { key: "owner", label: "Owner", description: "The officer who'll do it: handle, email or name" },
    { key: "due", label: "Due", description: "A date" },
  ],

  async validateRow(row): Promise<ImportRowCheck<ActionItemFields>> {
    const text = cell(row, "text")
    const label = clip(text || "(empty)", 120)
    const ownerText = cell(row, "owner")
    const owner = ownerText ? await officerFromCell(ownerText) : null
    if (owner && !owner.ok) return { ok: false, label, error: owner.error }
    const dueText = cell(row, "due")
    const due = dueText ? parseDateCell(dueText) : null
    if (dueText && !due) return { ok: false, label, error: `Due “${clip(dueText, 30)}” isn't a date` }
    const parsed = actionItemFieldsSchema.safeParse({ text, ownerId: owner?.ok ? owner.officer.id : null, dueAt: due ? dueDateValue(due) : null })
    if (!parsed.success) return { ok: false, label, error: parsed.error.issues[0]?.message ?? "Check the row" }
    const detail = [owner?.ok ? owner.officer.displayName : "No owner", due ? `due ${due}` : null].filter(Boolean).join(" · ")
    return { ok: true, value: parsed.data, label, detail }
  },

  async applyRows(rows, ctx) {
    const actor = { userId: ctx.officer.userId, auditMetadata: ctx.auditMetadata }
    const created = await prisma.$transaction(
      async (tx) => {
        const ids: { rowId: string; id: string }[] = []
        for (const { rowId, value } of rows) {
          const saved = await createActionItemTx(tx, value, actor, { roomId: ctx.roomId })
          if (!saved.ok) throw new Error(`${clip(value.text, 60)}: ${saved.error}`)
          ids.push({ rowId, id: saved.item.id })
        }
        return ids
      },
      { timeout: 60_000 },
    )
    revalidateQuietly(actionItemPaths())
    return {
      summary: `Added ${plural(created.length, "action item")}.`,
      links: [{ title: "Action items", url: ACTION_ITEMS_PAGE }],
      created: created.map((row) => ({ type: "ACTION_ITEM", id: row.id })),
      appliedRows: created.map((row) => row.rowId),
      counts: { added: created.length },
    }
  },
}
