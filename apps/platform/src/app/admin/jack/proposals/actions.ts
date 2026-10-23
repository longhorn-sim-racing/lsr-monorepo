"use server"

import { requireOfficer } from "@/server/auth/guards"
import { applyProposal, discardProposal, type ProposalDecision } from "@/server/jack/proposals/service"
import type { ActionResult } from "@/lib/action-result"
import type { JackMessageView } from "@/lib/jack/types"
import type { ProposalStateWithId } from "@/server/jack/proposals/service"

/**
 * Apply and Discard on a proposal card (#188, design §4.1). Any officer can do either; applying is
 * checked against the kind's permission with the applying officer's own roles, inside the service.
 * Both answer with the proposal's state after and the room note they posted (the room hears both live
 * too), and with an error when it didn't happen (already applied, stale, failed).
 */

export type ProposalActionData = { proposal: ProposalStateWithId; note: JackMessageView | null }
/** An ActionResult that, when it didn't happen, may still carry the proposal's state and a room note (it went stale or failed) */
export type ProposalActionResult =
  | Extract<ActionResult<ProposalActionData>, { ok: true }>
  | { ok: false; error: string; proposal?: ProposalStateWithId; note?: JackMessageView | null }

const ID = /^[0-9a-f-]{36}$/i
const MAX_ROWS = 2_000

export async function applyJackProposal(id: string, selectedRows?: string[]): Promise<ProposalActionResult> {
  const officer = await requireOfficer()
  if (typeof id !== "string" || !ID.test(id)) return { ok: false, error: "That proposal doesn't exist anymore." }
  if (selectedRows !== undefined && (!Array.isArray(selectedRows) || selectedRows.length > MAX_ROWS || selectedRows.some((row) => typeof row !== "string" || row.length > 200))) {
    return { ok: false, error: "Those rows can't be applied. Reload the room and try again." }
  }
  return toActionResult(await applyProposal(id, { id: officer.id, displayName: officer.displayName }, { selectedRows }))
}

export async function discardJackProposal(id: string): Promise<ProposalActionResult> {
  const officer = await requireOfficer()
  if (typeof id !== "string" || !ID.test(id)) return { ok: false, error: "That proposal doesn't exist anymore." }
  return toActionResult(await discardProposal(id, { id: officer.id, displayName: officer.displayName }))
}

function toActionResult(decision: ProposalDecision): ProposalActionResult {
  return decision.ok ? { ok: true, data: { proposal: decision.proposal, note: decision.note } } : decision
}
