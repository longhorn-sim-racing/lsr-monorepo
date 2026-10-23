import type { SponsorProspect } from "@prisma/client"
import { z } from "zod"
import { companyKey, PROSPECT_STAGE_LABEL, PROSPECT_STAGES, prospectPath, SPONSORS_PAGE, TIER_IDS, TIER_LABEL, type ProspectStage } from "@/lib/sponsor-prospects"
import {
  PROSPECT_FIELD_LABEL,
  PROSPECT_LIMITS,
  prospectChangesSchema,
  prospectFieldsSchema,
  type ProspectChanges,
  type ProspectFieldKey,
} from "@/schemas/sponsor-prospect.schema"
import { prisma } from "@/server/db"
import { userNames, type OfficerRef } from "@/server/services/officers"
import { createProspectTx, prospectPaths, prospectValue, updateProspectTx } from "@/server/services/sponsor.service"
import { centralDateInput, startOfCentralDay } from "../../tools/time"
import { ProposalInputError, StaleProposalError } from "../errors"
import type { ProposalDiffRow, ProposalKind, ProposalLink, ProposalPerson, ProposalRow } from "../types"
import { cardDay, clip, handleInput, idInput, listNames, officerFor, plural, resolveOfficers, revalidateQuietly } from "./shared"

/**
 * prospect.upsert (design §4.3, sponsors-meetings): add sponsor prospects or change existing ones, one
 * or many at once ("add these 8 prospects"). Each prospect is a row on the card, so officers can apply
 * some and not others. A new prospect whose company is already a prospect becomes an update of that one,
 * marked ambiguous (it starts unpicked). Rows are checked at apply time, only the picked ones: a row
 * whose fields moved on since (or a company added meanwhile) makes the proposal stale, and the picked
 * rows apply all or none, through the same service as the Sponsors page.
 */

const nullableText = (max: number) => z.string().trim().max(max).nullable().optional()

const prospectInput = z.object({
  prospectId: idInput.optional().describe("To change a prospect: its id from sponsors_list. Leave out to add a new one"),
  company: z.string().trim().min(1).max(PROSPECT_LIMITS.companyMax).optional().describe("The company's name (required for a new prospect)"),
  website: nullableText(PROSPECT_LIMITS.websiteMax).describe("acme.com or a full link"),
  contactName: nullableText(PROSPECT_LIMITS.nameMax),
  contactEmail: nullableText(PROSPECT_LIMITS.emailMax).describe("Only an address an officer gave you"),
  contactRole: nullableText(PROSPECT_LIMITS.roleMax),
  stage: z.enum(PROSPECT_STAGES).optional().describe("New ones default to idea"),
  tierInterest: z.enum(TIER_IDS).nullable().optional().describe("The sponsorship tier they're considering"),
  owner: handleInput.nullable().optional().describe("Handle of the officer handling it"),
  nextStep: nullableText(PROSPECT_LIMITS.nextStepMax),
  nextStepDue: centralDateInput.nullable().optional().describe("Central date, YYYY-MM-DD"),
  notes: nullableText(PROSPECT_LIMITS.notesMax),
})

type ProspectInput = z.infer<typeof prospectInput>

export const prospectUpsertSchema = z.object({
  prospects: z
    .array(prospectInput)
    .min(1)
    .max(25)
    .describe("One entry per prospect. On a change, give only the fields that change; null clears one")
    .superRefine((rows, ctx) => {
      const seen = new Set<string>()
      rows.forEach((row, i) => {
        if (!row.prospectId && !row.company) ctx.addIssue({ code: "custom", path: [i, "company"], message: "a new prospect needs its company" })
        if (row.prospectId) {
          if (seen.has(row.prospectId)) ctx.addIssue({ code: "custom", path: [i, "prospectId"], message: "the same prospect is in two rows; put its changes in one" })
          seen.add(row.prospectId)
          const fields = Object.entries(row).filter(([key]) => key !== "prospectId")
          if (fields.every(([, value]) => value === undefined)) ctx.addIssue({ code: "custom", path: [i], message: "nothing to change" })
        }
      })
    }),
})

export type ProspectUpsert = z.infer<typeof prospectUpsertSchema>

/** What each row does, as prepare() snapshots it: a new prospect, or one prospect's fields as they were */
const rowBefore = z.union([
  z.object({ action: z.literal("create"), company: z.string() }),
  z.object({ action: z.literal("update"), prospectId: z.string(), company: z.string(), fields: z.record(z.string(), z.string().nullable()) }),
  z.object({ action: z.literal("none") }),
])
const upsertBefore = z.object({ rows: z.record(z.string(), rowBefore) })
type UpsertBefore = z.infer<typeof upsertBefore>

const rowId = (i: number) => `p${i + 1}`
const FIELD_KEYS = ["company", "website", "contactName", "contactEmail", "contactRole", "stage", "tierInterest", "nextStep", "notes"] as const

/** A row's fields as the service takes them (owner handle to id, due date to an instant), only the ones given */
function rowFields(row: ProspectInput, owners: Map<string, OfficerRef>): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const key of FIELD_KEYS) if (row[key] !== undefined) fields[key] = row[key]
  if (row.owner !== undefined) fields.ownerId = row.owner === null ? null : (officerFor(owners, row.owner)?.id ?? null)
  if (row.nextStepDue !== undefined) fields.nextStepDue = row.nextStepDue === null ? null : startOfCentralDay(row.nextStepDue)
  return fields
}

/** A row checked like the Sponsors page checks it: a whole new prospect, or the changes to one */
function checkRow(row: ProspectInput, owners: Map<string, OfficerRef>, create: boolean, label: string): ProspectChanges {
  const fields = rowFields(row, owners)
  const parsed = create ? prospectFieldsSchema.safeParse(fields) : prospectChangesSchema.safeParse(fields)
  if (!parsed.success) throw new ProposalInputError(`${label}: ${parsed.error.issues[0]?.message ?? "check its fields"}`)
  return parsed.data
}

type Names = Map<string, OfficerRef>

/** A field's value for the card */
function show(key: ProspectFieldKey, value: unknown, names: Names): string | null {
  if (value === null || value === undefined || value === "") return null
  if (key === "stage") return PROSPECT_STAGE_LABEL[value as ProspectStage] ?? String(value)
  if (key === "tierInterest") return TIER_LABEL[value as keyof typeof TIER_LABEL] ?? String(value)
  if (key === "ownerId") return names.get(String(value))?.displayName ?? "Former officer"
  if (key === "nextStepDue") return cardDay(value as Date)
  return String(value)
}

/** Fields that would change on a prospect, and how */
function changedFields(current: SponsorProspect, changes: ProspectChanges): ProspectFieldKey[] {
  return (Object.keys(changes) as ProspectFieldKey[]).filter((key) => changes[key] !== undefined && prospectValue(changes[key]) !== prospectValue(current[key]))
}

/** How the card shows a field's change: notes diff line by line, single values as values */
function fieldFormat(key: ProspectFieldKey): ProposalDiffRow["format"] {
  return key === "notes" ? "markdown" : key === "nextStepDue" || key === "stage" || key === "tierInterest" ? "value" : "text"
}

/** A new prospect's row detail: "New · Talking · Gold · Dylan · contact Sam Lee (Partnerships), sam@… · next: send the packet (Fri Oct 30)" */
function createDetail(fields: ProspectChanges, names: Names): string {
  const contact = [fields.contactName ? `${fields.contactName}${fields.contactRole ? ` (${fields.contactRole})` : ""}` : null, fields.contactEmail].filter(Boolean).join(", ")
  const parts = [
    "New",
    show("stage", fields.stage ?? "idea", names),
    fields.tierInterest ? `${show("tierInterest", fields.tierInterest, names)} interest` : null,
    fields.ownerId ? show("ownerId", fields.ownerId, names) : "no owner",
    contact ? `contact ${contact}` : null,
    fields.nextStep ? `next: ${clip(fields.nextStep, 80)}${fields.nextStepDue ? ` (${cardDay(fields.nextStepDue)})` : ""}` : null,
    fields.notes ? "with notes" : null,
  ]
  return parts.filter(Boolean).join(" · ")
}

/** Every field a new prospect gets, in the card's diff (the company is the row and the label): what Apply writes, all of it */
const CREATE_SHOWN: ProspectFieldKey[] = ["website", "contactName", "contactRole", "contactEmail", "stage", "tierInterest", "ownerId", "nextStep", "nextStepDue", "notes"]

function updateDetail(current: SponsorProspect, changes: ProspectChanges, keys: ProspectFieldKey[], names: Names): string {
  return keys
    .map((key) => {
      if (key === "notes") return "Notes changed"
      return `${PROSPECT_FIELD_LABEL[key]}: ${clip(show(key, current[key], names) ?? "none", 60)} → ${clip(show(key, changes[key], names) ?? "none", 60)}`
    })
    .join("; ")
}

type Planned =
  | { rowId: string; action: "create"; company: string; fields: ProspectChanges }
  | { rowId: string; action: "update"; current: SponsorProspect; fields: ProspectChanges; keys: ProspectFieldKey[]; matchedByName: boolean }
  | { rowId: string; action: "none"; current: SponsorProspect }

/** Works out what each row does against the prospects as they are now. Throws ProposalInputError for input the model can fix */
async function plan(p: ProspectUpsert, owners: Map<string, OfficerRef>): Promise<Planned[]> {
  const ids = p.prospects.map((row) => row.prospectId).filter((id): id is string => Boolean(id))
  const all = await prisma.sponsorProspect.findMany()
  const byId = new Map(all.map((row) => [row.id, row]))
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length) throw new ProposalInputError(`There's no prospect with id ${missing.join(", ")}. Get ids from sponsors_list.`)

  const byKey = new Map<string, SponsorProspect>()
  for (const row of all) if (!byKey.has(companyKey(row.company))) byKey.set(companyKey(row.company), row)
  const newKeys = new Set<string>()
  /** The row (1-based) each existing prospect was matched by, by id or by company name */
  const matched = new Map<string, number>()

  return p.prospects.map((row, i) => {
    const id = rowId(i)
    const label = `Prospect ${i + 1}${row.company ? ` (${row.company})` : ""}`
    const existing = row.prospectId ? byId.get(row.prospectId)! : byKey.get(companyKey(row.company!))
    if (!existing) {
      const key = companyKey(row.company!)
      if (newKeys.has(key)) throw new ProposalInputError(`${label}: ${row.company} is in the list twice; put it in one row.`)
      newKeys.add(key)
      return { rowId: id, action: "create", company: row.company!, fields: checkRow(row, owners, true, label) }
    }
    // Two rows for one prospect (by id, or by its company's name) would apply against each other: one row each
    const first = matched.get(existing.id)
    if (first) throw new ProposalInputError(`Prospects ${first} and ${i + 1} are both ${existing.company}; put its changes in one row.`)
    matched.set(existing.id, i + 1)
    const fields = checkRow(row, owners, false, label)
    // A "new" row for a company that's already there: it only changes what it gives that differs
    if (!row.prospectId && fields.company !== undefined && companyKey(fields.company) === companyKey(existing.company)) delete fields.company
    const keys = changedFields(existing, fields)
    if (!keys.length) {
      if (row.prospectId) throw new ProposalInputError(`${label}: nothing would change for ${existing.company}; it already has these details.`)
      return { rowId: id, action: "none", current: existing }
    }
    return { rowId: id, action: "update", current: existing, fields, keys, matchedByName: !row.prospectId }
  })
}

function viewTitle(planned: Planned[]): string {
  const creates = planned.filter((row) => row.action === "create")
  const updates = planned.filter((row) => row.action === "update")
  if (planned.length === 1) {
    const only = planned[0]
    return only.action === "create" ? `Add the sponsor prospect “${only.company}”` : `Update the sponsor prospect “${only.current.company}”`
  }
  if (!updates.length) return `Add ${plural(creates.length, "sponsor prospect")}`
  if (!creates.length) return `Update ${plural(updates.length, "sponsor prospect")}`
  return `Add ${plural(creates.length, "sponsor prospect")} and update ${updates.length}`
}

export const prospectUpsertKind: ProposalKind<ProspectUpsert> = {
  kind: "prospect.upsert",
  tool: "propose_meeting",
  description:
    "prospect.upsert: add sponsor prospects or change existing ones (stage, owner, contact, next step, notes), several at once. For a change, give its prospectId from sponsors_list and only the fields that change. A new company that's already a prospect becomes a change to that one.",
  schema: prospectUpsertSchema,
  targetType: "SPONSOR_PROSPECT",
  permission: "officer",

  async prepare(p) {
    const owners = await resolveOfficers(
      p.prospects.map((row) => row.owner),
      "A prospect's owner",
    )
    const planned = await plan(p, owners)
    // Names for the owners as they are and as they'd be
    const names = await userNames([...[...owners.values()].map((o) => o.id), ...planned.map((row) => (row.action === "create" ? null : row.current.ownerId))])

    const diff: ProposalDiffRow[] = []
    const rows: ProposalRow[] = []
    const before: UpsertBefore = { rows: {} }
    for (const row of planned) {
      if (row.action === "create") {
        rows.push({ id: row.rowId, label: row.company, detail: createDetail(row.fields, names) })
        for (const key of CREATE_SHOWN) {
          const after = show(key, row.fields[key], names)
          if (after !== null) diff.push({ field: `${row.rowId}.${key}`, label: `${row.company}: ${PROSPECT_FIELD_LABEL[key]}`, before: null, after, format: fieldFormat(key) })
        }
        before.rows[row.rowId] = { action: "create", company: row.company }
      } else if (row.action === "update") {
        const detail = updateDetail(row.current, row.fields, row.keys, names)
        rows.push(
          row.matchedByName
            ? { id: row.rowId, label: row.current.company, detail: `Already a prospect: applying changes it. ${detail}`, status: "ambiguous" }
            : { id: row.rowId, label: row.current.company, detail },
        )
        for (const key of row.keys) {
          diff.push({
            field: `${row.rowId}.${key}`,
            label: `${row.current.company}: ${PROSPECT_FIELD_LABEL[key]}`,
            before: show(key, row.current[key], names),
            after: show(key, row.fields[key], names),
            format: fieldFormat(key),
          })
        }
        before.rows[row.rowId] = { action: "update", prospectId: row.current.id, company: row.current.company, fields: Object.fromEntries(row.keys.map((key) => [key, prospectValue(row.current[key])])) }
      } else {
        rows.push({ id: row.rowId, label: row.current.company, detail: "Already a prospect with these details: nothing to change.", status: "unmatched" })
        before.rows[row.rowId] = { action: "none" }
      }
    }

    const creates = planned.filter((row): row is Extract<Planned, { action: "create" }> => row.action === "create")
    const updates = planned.filter((row): row is Extract<Planned, { action: "update" }> => row.action === "update")
    if (!creates.length && !updates.length) throw new ProposalInputError("Nothing would change: every one of these is already a prospect with these details.")
    const ownerIds = new Set([...creates, ...updates].map((row) => row.fields.ownerId).filter((id): id is string => Boolean(id)))
    const people: ProposalPerson[] = [...ownerIds].flatMap((id) => {
      const owner = names.get(id)
      return owner ? [{ name: owner.displayName, detail: "Owner" }] : []
    })
    const what = [
      creates.length ? `adds ${listNames(creates.map((row) => row.company))} to Sponsors` : null,
      updates.length ? `updates ${listNames(updates.map((row) => row.current.company))}` : null,
    ].filter(Boolean)
    const single = planned.length === 1 && planned[0].action === "update" ? planned[0] : null
    const links: ProposalLink[] = [{ title: "Sponsors", url: SPONSORS_PAGE }, ...(single ? [{ title: single.current.company, url: prospectPath(single.current.id) }] : [])]

    return {
      before,
      ...(single ? { targetId: single.current.id } : {}),
      view: {
        title: viewTitle(planned),
        summary: `Applying it ${what.join(" and ")}.${planned.length > 1 ? " Pick which ones to apply." : ""}`,
        diff,
        rows,
        links,
        ...(people.length ? { people } : {}),
      },
    }
  },

  // The picked rows are checked in apply, so a change to a row an officer left out doesn't block the rest
  async checkStale() {
    return null
  },

  async apply(p, ctx) {
    const was = upsertBefore.safeParse(ctx.before)
    if (!was.success) throw new StaleProposalError("The proposal's copy of the prospects is missing. Ask Jack to propose it again.")
    let owners: Map<string, OfficerRef>
    try {
      owners = await resolveOfficers(
        p.prospects.map((row) => row.owner),
        "A prospect's owner",
      )
    } catch (error) {
      throw new StaleProposalError(error instanceof Error ? error.message : String(error))
    }
    const picked = new Set(ctx.selectedRows ?? p.prospects.map((_, i) => rowId(i)))
    const actor = { userId: ctx.officer.userId, auditMetadata: ctx.auditMetadata }

    const done = await prisma.$transaction(
      async (tx) => {
        const applied: { rowId: string; id: string; company: string; created: boolean }[] = []
        for (const [i, row] of p.prospects.entries()) {
          const id = rowId(i)
          const planned = was.data.rows[id]
          if (!picked.has(id) || !planned || planned.action === "none") continue
          const label = `Prospect ${i + 1}${row.company ? ` (${row.company})` : ""}`
          if (planned.action === "create") {
            const result = await createProspectTx(tx, checkRow(row, owners, true, label), actor)
            if (!result.ok) throw result.reason === "duplicate" ? new StaleProposalError(`${planned.company} was added as a prospect since this was proposed.`) : new Error(`${label}: ${result.error}`)
            applied.push({ rowId: id, id: result.prospect.id, company: result.prospect.company, created: true })
          } else {
            const fields = checkRow(row, owners, false, label)
            const changes = Object.fromEntries(Object.keys(planned.fields).map((key) => [key, fields[key as ProspectFieldKey]]))
            const result = await updateProspectTx(tx, planned.prospectId, changes, actor, { expected: planned.fields })
            if (!result.ok) {
              if (result.reason === "changed") throw new StaleProposalError(`${planned.company} changed since this was proposed.`)
              if (result.reason === "not_found") throw new StaleProposalError(`${planned.company} was deleted since this was proposed.`)
              throw new Error(`${label}: ${result.error}`)
            }
            applied.push({ rowId: id, id: planned.prospectId, company: result.prospect.company, created: false })
          }
        }
        return applied
      },
      { timeout: 30_000 },
    )

    if (!done.length) throw new Error("None of the picked rows had anything to change.")
    revalidateQuietly(done.flatMap((row) => prospectPaths(row.id)))
    const created = done.filter((row) => row.created)
    const updated = done.filter((row) => !row.created)
    const summary = [created.length ? `Added ${plural(created.length, "sponsor prospect")}` : null, updated.length ? `${created.length ? "updated" : "Updated"} ${plural(updated.length, "prospect")}` : null].filter(Boolean).join(" and ")
    return {
      summary: `${summary}.`,
      links: [...(done.length === 1 ? [{ title: done[0].company, url: prospectPath(done[0].id) }] : []), { title: "Sponsors", url: SPONSORS_PAGE }],
      created: created.map((row) => ({ type: "SPONSOR_PROSPECT", id: row.id })),
      appliedRows: done.map((row) => row.rowId),
      counts: { added: created.length, updated: updated.length },
    }
  },
}
