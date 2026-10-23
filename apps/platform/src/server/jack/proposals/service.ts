import { randomUUID } from "node:crypto"
import { Prisma, type JackProposal } from "@prisma/client"
import type { ZodError } from "zod"
import { describeLineChanges, diffHunks, diffStats, lineDiff } from "@/lib/jack/line-diff"
import type { JackProposalDisplay } from "@/lib/jack/parts"
import { isCardImagePath, isNotePath, noteWithLink, type JackProposalDetail, type JackProposalDiffRow, type JackProposalImage, type JackProposalRow } from "@/lib/jack/proposals"
import { JACK_EVENT, type JackMessageView, type JackProposalResult, type JackProposalState } from "@/lib/jack/types"
import { redactSecrets } from "@/lib/redact"
import { createAuditLog } from "@/server/audit/log"
import { prisma } from "@/server/db"
import { broadcastRoomEvent, type RoomBroadcaster } from "../broadcast"
import { FORMER_OFFICER, jackMessageInclude, toMessageView } from "../messages"
import { ProposalInputError, StaleProposalError } from "./errors"
import { findProposalKind } from "./registry"
import type { AnyProposalKind, ProposalAuditMetadata, ProposalDiffRow, ProposalPermission, ProposalRow, ProposalView } from "./types"

/**
 * Proposed changes (#188, design §4.1): Jack proposes, an officer applies.
 *
 * - createProposal: a propose_* tool's input, validated by its kind, described on the server by the
 *   kind's prepare() and saved PENDING. A newer proposal for the same kind and target in the room
 *   supersedes the older pending ones.
 * - applyProposal: the applying officer's roles are checked against the proposal's permission, then
 *   it's claimed (PENDING to APPLYING in one conditional UPDATE, so of two officers clicking at once
 *   only one gets it), then, outside any transaction, re-validated (parsed before the claim, since the
 *   permission and rows can depend on the payload), its file checked, checkStale() run and apply()
 *   called. It ends APPLIED, FAILED or STALE, with an audit entry for APPLIED and FAILED.
 * - discardProposal: PENDING to DISCARDED.
 * - Expiry is lazy: a PENDING proposal past expiresAt reads as STALE, and is set so when someone applies
 *   or discards it, or by the sweep job (sweepProposals, which also fails applies that stopped partway).
 *   Reading it (the card's route) never writes.
 *
 * Every final status posts a room note, and every change broadcasts proposal.updated, so the room's
 * cards follow along and Jack's history carries the outcome ("(Room note: Dylan applied: …)").
 */

/** A proposal nobody applies goes stale after this long */
export const PROPOSAL_TTL_MS = 14 * 24 * 60 * 60_000
/** An apply still APPLYING after this long stopped partway (its function died); the sweep marks it FAILED */
export const APPLYING_TIMEOUT_MS = 10 * 60_000

/** Changed fields the room's display carries; the card loads the rest */
const PREVIEW_ROWS = 4
const PREVIEW_CHARS = 160
/** Text fields in the route's view are cut at this; long text goes as a line diff instead */
const DETAIL_TEXT_CHARS = 4_000

const EXPIRED = "Nobody applied it within 14 days."
const STOPPED = "The apply stopped before it finished, so part of it may have happened. Check what it changes before asking Jack to propose it again."
const SUPERSEDED = "Replaced by a newer proposal."

export type ProposalDeps = {
  broadcast: RoomBroadcaster
  findKind: (kind: string) => AnyProposalKind | undefined
  now: () => Date
}

export const defaultProposalDeps: ProposalDeps = { broadcast: broadcastRoomEvent, findKind: findProposalKind, now: () => new Date() }

/** A proposal's id and live state, as the proposal.updated event and the actions send it */
export type ProposalStateWithId = { id: string } & JackProposalState

/** What apply and discard report: the proposal's state after, and the room note they posted */
export type ProposalDecision =
  | { ok: true; proposal: ProposalStateWithId; note: JackMessageView | null }
  | { ok: false; error: string; proposal?: ProposalStateWithId; note?: JackMessageView | null }

export type ProposalOfficer = { id: string; displayName: string }

/* Proposing */

export type CreateProposalInput = {
  kind: string
  payload: unknown
  roomId: string
  /** The reply proposing it */
  messageId?: string
  /** The officer it's proposed for (the asker); userId null outside a room reply */
  proposedFor: { userId: string | null; displayName: string }
  signal?: AbortSignal
}

export type CreateProposalOutcome =
  | { ok: true; proposal: JackProposalDisplay; superseded: string[] }
  /** The input can't make a proposal; the model gets this and can try again */
  | { ok: false; error: string }

/**
 * Validates the payload, has the kind describe it (prepare, no writes), saves it PENDING and supersedes
 * older pending proposals for the same kind and target in the room. Returns the room's small display.
 */
export async function createProposal(input: CreateProposalInput, deps: ProposalDeps = defaultProposalDeps): Promise<CreateProposalOutcome> {
  const kind = deps.findKind(input.kind)
  if (!kind) return { ok: false, error: `There's no proposal kind "${input.kind}".` }
  const parsed = kind.schema.safeParse(input.payload)
  if (!parsed.success) return { ok: false, error: `The ${kind.kind} proposal isn't valid: ${issuesText(parsed.error)}` }

  const room = await prisma.jackRoom.findUnique({ where: { id: input.roomId }, select: { id: true } })
  if (!room) return { ok: false, error: "This room doesn't exist anymore." }

  let prepared
  try {
    prepared = await kind.prepare(parsed.data, { roomId: input.roomId, messageId: input.messageId, officer: input.proposedFor, signal: input.signal })
  } catch (error) {
    if (error instanceof ProposalInputError) return { ok: false, error: error.message }
    throw error
  }

  const view = plainView(prepared.view)
  const id = randomUUID()
  const now = deps.now()
  const targetType = kind.targetType ?? null
  const targetId = prepared.targetId ?? null

  const superseded = await prisma.$transaction(async (tx) => {
    await tx.jackProposal.create({
      data: {
        id,
        roomId: input.roomId,
        messageId: input.messageId ?? null,
        kind: kind.kind,
        title: view.title,
        summary: view.summary,
        payload: json(parsed.data),
        before: prepared.before === undefined || prepared.before === null ? Prisma.DbNull : json(prepared.before),
        view: json(view),
        targetType,
        targetId,
        status: "PENDING",
        proposedForId: input.proposedFor.userId,
        expiresAt: new Date(now.getTime() + PROPOSAL_TTL_MS),
        fileSha256: prepared.fileSha256 ?? null,
      },
    })
    if (!targetId) return []
    const older = await tx.jackProposal.findMany({
      where: { roomId: input.roomId, kind: kind.kind, targetType, targetId, status: "PENDING", id: { not: id } },
      select: { id: true },
    })
    const replaced: string[] = []
    for (const { id: olderId } of older) {
      // Conditional, so one an officer is applying right now isn't replaced under them
      const { count } = await tx.jackProposal.updateMany({
        where: { id: olderId, status: "PENDING" },
        data: { status: "SUPERSEDED", supersededById: id, result: { summary: SUPERSEDED } },
      })
      if (count) replaced.push(olderId)
    }
    return replaced.length ? tx.jackProposal.findMany({ where: { id: { in: replaced } } }) : []
  })

  for (const row of superseded) {
    await postNote(row.roomId, `Superseded: ${row.title}. Jack proposed a newer version.`, null, deps)
    await broadcastState(row, deps)
  }

  return { ok: true, proposal: proposalDisplay(id, kind, view), superseded: superseded.map((row) => row.id) }
}

/** The small display a reply carries (well under Realtime's limit): the card loads the full view from the route */
export function proposalDisplay(id: string, kind: AnyProposalKind, view: ProposalView): JackProposalDisplay {
  const counts: Record<string, number> = {}
  for (const row of view.rows ?? []) counts[row.status ?? "rows"] = (counts[row.status ?? "rows"] ?? 0) + 1
  return {
    kind: "proposal",
    proposalId: id,
    proposalKind: kind.kind,
    title: view.title,
    summary: view.summary,
    ...(Object.keys(counts).length ? { counts } : {}),
    preview: view.diff.slice(0, PREVIEW_ROWS).map((row) => {
      if (isLongText(row)) return { label: row.label, before: null, after: describeLineChanges(diffStats(lineDiff(row.before ?? "", row.after ?? ""))), format: "markdown" as const }
      return { label: row.label, before: clip(row.before, PREVIEW_CHARS), after: clip(row.after, PREVIEW_CHARS), format: row.format }
    }),
  }
}

/* Applying and discarding */

/**
 * Applies a proposal as `officer` (design §4.1 step 3). The proposal's permission (the kind's, or
 * stricter for this payload) is checked against this officer's roles, whoever it was proposed for.
 * `selectedRows` picks the rows to apply, for a proposal with rows (pickableRows); left out, every row
 * applies.
 */
export async function applyProposal(
  id: string,
  officer: ProposalOfficer,
  { selectedRows }: { selectedRows?: string[] } = {},
  deps: ProposalDeps = defaultProposalDeps,
): Promise<ProposalDecision> {
  const row = await prisma.jackProposal.findUnique({ where: { id } })
  if (!row) return { ok: false, error: "That proposal doesn't exist anymore." }
  const kind = deps.findKind(row.kind)
  if (!kind) return { ok: false, error: "This version of the site can't apply this kind of proposal.", proposal: stateWithId(row, deps.now()) }
  // Validated again now (it was when proposed); a payload that no longer passes fails once claimed, below
  const payload = kind.schema.safeParse(row.payload)

  const roles = await rolesOf(officer.id)
  const permission = permissionOf(kind, payload)
  if (!mayApply(permission, roles)) return { ok: false, error: permission === "admin" ? "Only admins can apply this kind of change." : "Only officers can apply proposals." }

  if (isExpired(row, deps.now())) return expiredDecision(await expireProposal(row, deps), deps)
  if (row.status !== "PENDING") return { ok: false, error: alreadyDecided(row), proposal: stateWithId(row, deps.now()) }

  let selection: string[] | undefined
  if (selectedRows !== undefined) {
    const rows = pickableRows(kind, row, payload)
    if (!rows) return { ok: false, error: "This proposal has no rows to pick from. Reload the room and try again." }
    const known = new Set(rows.map((r) => r.id))
    selection = [...new Set(selectedRows)]
    if (!selection.length) return { ok: false, error: "Pick at least one row to apply." }
    if (selection.some((rowId) => !known.has(rowId))) return { ok: false, error: "Some of the picked rows aren't in this proposal. Reload the room and try again." }
  }

  // The claim: only one Apply gets past this, and only while the proposal is pending and unexpired
  const claimedAt = deps.now()
  const { count } = await prisma.jackProposal.updateMany({
    where: { id, status: "PENDING", expiresAt: { gt: claimedAt } },
    data: { status: "APPLYING", claimedAt, decidedById: officer.id },
  })
  if (!count) {
    const current = await prisma.jackProposal.findUnique({ where: { id } })
    if (!current) return { ok: false, error: "That proposal doesn't exist anymore." }
    if (isExpired(current, deps.now())) return expiredDecision(await expireProposal(current, deps), deps)
    return { ok: false, error: alreadyDecided(current), proposal: stateWithId(current, deps.now()) }
  }
  const claimed = await prisma.jackProposal.findUniqueOrThrow({ where: { id } })
  await broadcastState(claimed, deps)

  const audit: ProposalAuditMetadata = { via: "jack", proposalId: id, roomId: row.roomId, proposedFor: row.proposedForId }
  const finish = (status: "APPLIED" | "FAILED" | "STALE", result: JackProposalResult) => finishApply(claimed, officer, status, result, audit, deps)

  // Outside any transaction from here: the proposal is claimed, so nothing else will touch it
  if (!payload.success) return finish("FAILED", { summary: `It no longer passes its checks (${issuesText(payload.error)}).` })

  try {
    if (row.fileSha256) {
      const changed = await fileChanged(row.payload, row.fileSha256)
      if (changed) return finish("STALE", { summary: changed })
    }
    const stale = await kind.checkStale(payload.data, row.before)
    if (stale) return finish("STALE", { summary: stale })

    const result = await kind.apply(payload.data, {
      officer: { userId: officer.id, displayName: officer.displayName },
      proposalId: id,
      roomId: row.roomId,
      selectedRows: selection,
      idempotencyKey: `proposal:${id}`,
      before: row.before,
      auditMetadata: audit,
    })
    const plain = json(result) as JackProposalResult
    return finish("APPLIED", { ...plain, summary: plain.summary || "Applied.", ...(selection && !plain.appliedRows ? { appliedRows: selection } : {}) })
  } catch (error) {
    if (error instanceof StaleProposalError) return finish("STALE", { summary: error.message })
    console.error(`[jack] Applying proposal ${id} (${row.kind}) failed:`, error)
    return finish("FAILED", { summary: redactSecrets(error instanceof Error ? error.message : String(error)) || "Something went wrong." })
  }
}

async function finishApply(
  row: JackProposal,
  officer: ProposalOfficer,
  status: "APPLIED" | "FAILED" | "STALE",
  result: JackProposalResult,
  audit: ProposalAuditMetadata,
  deps: ProposalDeps,
): Promise<ProposalDecision> {
  // Unconditional: this apply holds the claim, and its outcome is the truth even if the sweep gave up on it meanwhile
  const final = await prisma.jackProposal.update({ where: { id: row.id }, data: { status, result: json(result), decidedById: officer.id, decidedAt: deps.now() } })
  if (status !== "STALE") {
    await createAuditLog({
      actorUserId: officer.id,
      actionType: status === "APPLIED" ? "APPLY" : "APPLY_FAILED",
      entityType: "JACK_PROPOSAL",
      entityId: row.id,
      summary: `${status === "APPLIED" ? "Applied" : "Couldn't apply"} Jack's proposal: ${row.title}`,
      before: row.before ?? undefined,
      after: { kind: row.kind, targetType: row.targetType, targetId: row.targetId, payload: row.payload, result },
      metadata: { ...audit, kind: row.kind },
    })
  }
  const text =
    status === "APPLIED"
      ? noteWithLink(`${officer.displayName} applied: ${row.title}`, firstSiteLink(result.links))
      : status === "FAILED"
        ? `Couldn't apply: ${row.title}. ${sentence(result.summary)}`
        : `Stale: ${row.title}. ${sentence(result.summary)}`
  const note = await postNote(row.roomId, text, officer.id, deps)
  const proposal = await broadcastState(final, deps)
  return status === "APPLIED" ? { ok: true, proposal, note } : { ok: false, error: result.summary, proposal, note }
}

/** Any officer can discard a pending proposal, whatever its kind */
export async function discardProposal(id: string, officer: ProposalOfficer, deps: ProposalDeps = defaultProposalDeps): Promise<ProposalDecision> {
  const row = await prisma.jackProposal.findUnique({ where: { id } })
  if (!row) return { ok: false, error: "That proposal doesn't exist anymore." }
  if (isExpired(row, deps.now())) return expiredDecision(await expireProposal(row, deps), deps)

  const now = deps.now()
  const { count } = await prisma.jackProposal.updateMany({
    where: { id, status: "PENDING" },
    data: { status: "DISCARDED", decidedById: officer.id, decidedAt: now, result: { summary: `Discarded by ${officer.displayName}.` } },
  })
  const current = await prisma.jackProposal.findUnique({ where: { id } })
  if (!current) return { ok: false, error: "That proposal doesn't exist anymore." }
  if (!count) return { ok: false, error: alreadyDecided(current), proposal: stateWithId(current, now) }

  await createAuditLog({
    actorUserId: officer.id,
    actionType: "DISCARD",
    entityType: "JACK_PROPOSAL",
    entityId: id,
    summary: `Discarded Jack's proposal: ${row.title}`,
    after: { kind: row.kind, targetType: row.targetType, targetId: row.targetId, payload: row.payload },
    metadata: { via: "jack", proposalId: id, roomId: row.roomId, proposedFor: row.proposedForId, kind: row.kind } satisfies ProposalAuditMetadata & { kind: string },
  })
  const note = await postNote(row.roomId, `Discarded by ${officer.displayName}: ${row.title}`, officer.id, deps)
  const proposal = await broadcastState(current, deps)
  return { ok: true, proposal, note }
}

/* Reading */

/** Every proposal in a room, by id, as the room's snapshot carries them (newest 500) */
export async function roomProposalStates(roomId: string, deps: Pick<ProposalDeps, "now"> = defaultProposalDeps): Promise<Record<string, JackProposalState>> {
  const rows = await prisma.jackProposal.findMany({
    where: { roomId },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: { id: true, status: true, result: true, updatedAt: true, expiresAt: true },
  })
  const now = deps.now()
  return Object.fromEntries(rows.map((row) => [row.id, stateOf(row, now)]))
}

/**
 * The full proposal for its card and the officer route: the saved view with long text as a line diff,
 * names, and whether `viewerId` may apply it. Only reads: a pending proposal past its expiry reads as
 * STALE here, and the sweep (or an apply or discard) writes it down with its note, so opening an old
 * room doesn't post a pile of late notes. Null when there's no such proposal.
 */
export async function getProposalDetail(id: string, viewerId: string, deps: ProposalDeps = defaultProposalDeps): Promise<JackProposalDetail | null> {
  const row = await prisma.jackProposal.findUnique({ where: { id } })
  if (!row) return null

  const kind = deps.findKind(row.kind)
  const view = savedView(row)
  const state = stateOf(row, deps.now())
  const payload = kind ? kind.schema.safeParse(row.payload) : null
  const permission: ProposalPermission = kind && payload ? permissionOf(kind, payload) : "admin"
  const names = await namesOf([row.proposedForId, row.decidedById])
  const roles = kind && state.status === "PENDING" ? await rolesOf(viewerId) : []
  // The same rows Apply checks picks against, so the card only offers checkboxes Apply honours
  const rows: JackProposalRow[] | null = (kind && payload ? pickableRows(kind, row, payload) : (view.rows ?? null))?.map(cardRow) ?? null

  return {
    id: row.id,
    roomId: row.roomId,
    messageId: row.messageId,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    status: state.status,
    result: state.result ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: state.updatedAt,
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    proposedFor: row.proposedForId ? (names.get(row.proposedForId) ?? FORMER_OFFICER) : null,
    decidedBy: row.decidedById ? (names.get(row.decidedById) ?? FORMER_OFFICER) : null,
    supersededById: row.supersededById,
    diff: view.diff.map(detailRow),
    people: view.people ?? [],
    links: view.links ?? [],
    rows,
    preview: view.preview ?? null,
    images: cardImages(view),
    permission,
    destructive: kind?.destructive ?? false,
    canApply: Boolean(kind) && state.status === "PENDING" && mayApply(permission, roles),
    known: Boolean(kind),
  }
}

/* The sweep */

/**
 * The scheduled sweep (jobs/proposals.ts): applies still APPLYING after APPLYING_TIMEOUT_MS stopped
 * partway (their function died) and become FAILED, never retried; pending proposals past expiresAt
 * become STALE. Each gets its room note.
 */
export async function sweepProposals({ signal }: { signal?: AbortSignal } = {}, deps: ProposalDeps = defaultProposalDeps): Promise<{ failed: number; expired: number }> {
  const now = deps.now()
  const cutoff = new Date(now.getTime() - APPLYING_TIMEOUT_MS)
  let failed = 0
  let expired = 0

  const stuck = await prisma.jackProposal.findMany({ where: { status: "APPLYING", claimedAt: { lt: cutoff } }, orderBy: { claimedAt: "asc" }, take: 100 })
  for (const row of stuck) {
    if (signal?.aborted) break
    const { count } = await prisma.jackProposal.updateMany({
      where: { id: row.id, status: "APPLYING", claimedAt: { lt: cutoff } },
      data: { status: "FAILED", decidedAt: now, result: { summary: STOPPED } },
    })
    if (!count) continue
    failed++
    const final = await prisma.jackProposal.findUniqueOrThrow({ where: { id: row.id } })
    await createAuditLog({
      actorUserId: null,
      actionType: "APPLY_FAILED",
      entityType: "JACK_PROPOSAL",
      entityId: row.id,
      summary: `Jack's proposal stopped partway through applying: ${row.title}`,
      after: { kind: row.kind, targetType: row.targetType, targetId: row.targetId, payload: row.payload, result: final.result },
      metadata: { via: "jack", proposalId: row.id, roomId: row.roomId, proposedFor: row.proposedForId, kind: row.kind, appliedBy: row.decidedById },
    })
    await postNote(row.roomId, noteWithLink(`Couldn't apply: ${row.title}. ${STOPPED}`, firstSiteLink(savedView(row).links)), null, deps)
    await broadcastState(final, deps)
  }

  const due = await prisma.jackProposal.findMany({ where: { status: "PENDING", expiresAt: { lte: now } }, orderBy: { expiresAt: "asc" }, take: 200 })
  for (const row of due) {
    if (signal?.aborted) break
    if ((await expireProposal(row, deps)).changed) expired++
  }
  return { failed, expired }
}

/* Helpers */

/** The proposal's state for the room: a pending one past its expiry reads as STALE before anything writes it */
function stateOf(row: Pick<JackProposal, "status" | "result" | "updatedAt" | "expiresAt">, now: Date): JackProposalState {
  const expired = row.status === "PENDING" && row.expiresAt <= now
  const result = expired ? { summary: EXPIRED } : resultOf(row.result)
  return { status: expired ? "STALE" : row.status, ...(result ? { result } : {}), updatedAt: row.updatedAt.toISOString() }
}

function stateWithId(row: JackProposal, now: Date): ProposalStateWithId {
  return { id: row.id, ...stateOf(row, now) }
}

function resultOf(value: Prisma.JsonValue | null): JackProposalResult | undefined {
  return value && typeof value === "object" && !Array.isArray(value) && typeof (value as { summary?: unknown }).summary === "string" ? (value as unknown as JackProposalResult) : undefined
}

function isExpired(row: Pick<JackProposal, "status" | "expiresAt">, now: Date): boolean {
  return row.status === "PENDING" && row.expiresAt <= now
}

/**
 * Sets an expired pending proposal STALE with its note. Conditional, so only one caller does it (the
 * sweep and a click can race); returns the row as it is now and whether this call changed it
 */
async function expireProposal(row: JackProposal, deps: ProposalDeps): Promise<{ row: JackProposal | null; changed: boolean }> {
  const now = deps.now()
  const { count } = await prisma.jackProposal.updateMany({
    where: { id: row.id, status: "PENDING", expiresAt: { lte: now } },
    data: { status: "STALE", result: { summary: EXPIRED } },
  })
  const current = await prisma.jackProposal.findUnique({ where: { id: row.id } })
  if (count && current) {
    await postNote(row.roomId, `Stale: ${row.title}. ${EXPIRED}`, null, deps)
    await broadcastState(current, deps)
  }
  return { row: current, changed: Boolean(count && current) }
}

function expiredDecision({ row }: { row: JackProposal | null }, deps: ProposalDeps): ProposalDecision {
  if (!row) return { ok: false, error: "That proposal doesn't exist anymore." }
  return { ok: false, error: row.status === "STALE" ? `It expired: ${EXPIRED.toLowerCase()}` : alreadyDecided(row), proposal: stateWithId(row, deps.now()) }
}

/** Why a proposal that isn't pending can't be applied or discarded */
function alreadyDecided(row: JackProposal): string {
  const reason = resultOf(row.result)?.summary
  switch (row.status) {
    case "APPLYING":
      return "An officer is applying it right now."
    case "APPLIED":
      return "It was already applied."
    case "DISCARDED":
      return "It was already discarded."
    case "FAILED":
      return "It already failed to apply. Ask Jack to propose it again."
    case "STALE":
      return reason ? `It's stale: ${lowerFirst(reason)}` : "It's stale."
    case "SUPERSEDED":
      return "A newer proposal replaced it."
    default:
      return "It's not pending anymore."
  }
}

async function broadcastState(row: JackProposal, deps: ProposalDeps): Promise<ProposalStateWithId> {
  const proposal = stateWithId(row, deps.now())
  await deps.broadcast(row.roomId, { type: JACK_EVENT.proposal, roomId: row.roomId, proposal })
  return proposal
}

/** A room note (a system message), shown to the room and part of Jack's history from then on */
async function postNote(roomId: string, content: string, authorUserId: string | null, deps: ProposalDeps): Promise<JackMessageView> {
  const row = await prisma.jackMessage.create({ data: { roomId, kind: "system", authorUserId, content: clip(content, 1_000) ?? "" }, include: jackMessageInclude })
  const message = toMessageView(row)
  await deps.broadcast(roomId, { type: JACK_EVENT.created, message })
  return message
}

export function mayApply(permission: ProposalPermission, roles: string[]): boolean {
  return permission === "admin" ? roles.includes("admin") : roles.includes("admin") || roles.includes("officer")
}

type ParsedPayload = ReturnType<AnyProposalKind["schema"]["safeParse"]>

/**
 * Who may apply this proposal: the kind's permission, or stricter when its permissionFor() says so for
 * this payload (an import into an admin-only target). Never looser than the kind's own; a payload that
 * no longer parses gets the kind's own (it fails once claimed anyway), and a permissionFor() that
 * throws means admin
 */
function permissionOf(kind: AnyProposalKind, payload: ParsedPayload): ProposalPermission {
  if (kind.permission === "admin" || !kind.permissionFor || !payload.success) return kind.permission
  try {
    return kind.permissionFor(payload.data) === "admin" ? "admin" : kind.permission
  } catch (error) {
    console.error(`[jack] permissionFor of proposal kind ${kind.kind} threw; only admins can apply it:`, error)
    return "admin"
  }
}

/**
 * The rows an officer picks from, or null for a proposal without rows: the ones prepare() saved in the
 * view (what the card showed, built on the server: an import's file rows, a notification's audience),
 * else the kind's list.rows() over the payload. Apply checks picks against these and the card gets the
 * same ones, so every checkbox offered is honoured
 */
function pickableRows(kind: AnyProposalKind, row: Pick<JackProposal, "title" | "summary" | "view">, payload: ParsedPayload): ProposalRow[] | null {
  const saved = savedView(row).rows
  if (saved) return saved
  return kind.list && payload.success ? kind.list.rows(payload.data) : null
}

/** The officer's roles as the database has them now (not as their session last saw them) */
async function rolesOf(userId: string): Promise<string[]> {
  const rows = await prisma.userRole.findMany({ where: { userId }, select: { role: { select: { key: true } } } })
  return rows.map((row) => row.role.key)
}

async function namesOf(ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  if (!wanted.length) return new Map()
  const users = await prisma.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })
  return new Map(users.map((user) => [user.id, user.displayName]))
}

/** Kinds built from a room file name it as `fileId`: why it can't be applied any more, or null when it's the same file */
async function fileChanged(payload: Prisma.JsonValue, sha256: string): Promise<string | null> {
  const fileId = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as { fileId?: unknown }).fileId : undefined
  if (typeof fileId !== "string") return "It was built from a file the proposal doesn't name any more."
  const file = await prisma.jackFile.findUnique({ where: { id: fileId }, select: { sha256: true, status: true } })
  if (!file) return "The file it was built from was deleted."
  if (file.status !== "READY" || file.sha256 !== sha256) return "The file it was built from changed since this was proposed."
  return null
}

/** The view as saved, read defensively (it's JSON from the database); older rows without one show the title and summary */
function savedView(row: Pick<JackProposal, "title" | "summary" | "view">): ProposalView {
  const value = row.view
  const view = value && typeof value === "object" && !Array.isArray(value) ? (value as Partial<ProposalView>) : {}
  return {
    title: typeof view.title === "string" ? view.title : row.title,
    summary: typeof view.summary === "string" ? view.summary : row.summary,
    diff: Array.isArray(view.diff) ? view.diff : [],
    ...(Array.isArray(view.people) ? { people: view.people } : {}),
    ...(Array.isArray(view.links) ? { links: view.links } : {}),
    ...(Array.isArray(view.rows) ? { rows: view.rows } : {}),
    ...(view.preview && typeof view.preview === "object" && Array.isArray(view.preview.blocks) ? { preview: view.preview } : {}),
    ...(Array.isArray(view.images) ? { images: view.images } : {}),
  }
}

/** The pictures a card may load: this site's officer-only image routes only, on the images and the rows */
function cardImages(view: ProposalView): JackProposalImage[] {
  return (view.images ?? []).filter((image) => typeof image?.url === "string" && isCardImagePath(image.url)).map((image) => ({ url: image.url, alt: String(image.alt ?? ""), ...(image.label ? { label: String(image.label) } : {}) }))
}

function cardRow(row: ProposalRow): JackProposalRow {
  if (row.thumbUrl === undefined || isCardImagePath(row.thumbUrl)) return row
  return { id: row.id, label: row.label, ...(row.detail !== undefined ? { detail: row.detail } : {}), ...(row.status ? { status: row.status } : {}) }
}

/** A kind's view as plain JSON, with the title and summary kept to sizes the room and the table hold */
function plainView(view: ProposalView): ProposalView {
  const plain = json(view) as unknown as ProposalView
  return {
    ...plain,
    title: clip(plain.title?.trim() || "Proposed change", 200)!,
    summary: clip(plain.summary?.trim() ?? "", 1_000)!,
    diff: Array.isArray(plain.diff) ? plain.diff : [],
  }
}

/** Long text (pages, posts) and anything on several lines gets a line diff on the card */
function isLongText(row: ProposalDiffRow): boolean {
  return row.format === "markdown" || /\n/.test(row.before ?? "") || /\n/.test(row.after ?? "")
}

function detailRow(row: ProposalDiffRow): JackProposalDiffRow {
  if (!isLongText(row)) return { ...row, before: clip(row.before, DETAIL_TEXT_CHARS), after: clip(row.after, DETAIL_TEXT_CHARS) }
  const lines = lineDiff(row.before ?? "", row.after ?? "")
  return { field: row.field, label: row.label, format: row.format, before: null, after: null, lines: diffHunks(lines), stats: diffStats(lines) }
}

/** The first link inside the site (the note's "→ /admin/…"); outside links stay on the card, with their host */
function firstSiteLink(links: { url: string }[] | undefined): string | null {
  return links?.find((link) => isNotePath(link.url))?.url ?? null
}

function issuesText(error: ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
    .join("; ")
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue
}

function clip(text: string | null | undefined, max: number): string | null {
  if (text === null || text === undefined) return null
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function sentence(text: string): string {
  const trimmed = text.trim()
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

function lowerFirst(text: string): string {
  return text ? text[0].toLowerCase() + text.slice(1) : text
}
