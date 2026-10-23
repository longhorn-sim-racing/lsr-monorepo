import type { DiffHunkLine } from "./line-diff"
import type { JackProposalPreview } from "./markdown-preview"
import type { JackProposalLink, JackProposalResult, JackProposalState, JackProposalStatusKey } from "./types"

/**
 * A proposal as its card and the Proposals page show it (#188, design §4.1). Plain JSON: the officer
 * route GET /api/admin/jack/proposals/[id] sends it, built on the server from the saved proposal.
 */

/** One changed field. Long text comes as `lines` (a line diff with a little context) instead of before and after */
export type JackProposalDiffRow = {
  field: string
  label: string
  format: "text" | "value" | "markdown"
  before: string | null
  after: string | null
  lines?: DiffHunkLine[]
  /** With `lines`: how many lines it adds and removes */
  stats?: { added: number; removed: number }
}

/** A row of a list kind, with a checkbox on the card */
export type JackProposalRow = { id: string; label: string; detail?: string; status?: "matched" | "ambiguous" | "unmatched" }

export type JackProposalDetail = {
  id: string
  roomId: string
  /** The reply that proposed it */
  messageId: string | null
  kind: string
  title: string
  summary: string
  status: JackProposalStatusKey
  result: JackProposalResult | null
  /** ISO timestamps */
  createdAt: string
  updatedAt: string
  expiresAt: string
  decidedAt: string | null
  /** Names: the officer it was proposed for, and who applied or discarded it ("Former officer" once they're gone) */
  proposedFor: string | null
  decidedBy: string | null
  supersededById: string | null
  diff: JackProposalDiffRow[]
  people: { name: string; detail?: string }[]
  links: JackProposalLink[]
  /** The rows to pick from, when it has any: exactly the ones Apply checks picks against */
  rows: JackProposalRow[] | null
  /** A rendered preview of the Markdown it publishes (a news post), or null */
  preview: JackProposalPreview | null
  permission: "officer" | "admin"
  /** Applying it can't be taken back: the card asks first */
  destructive: boolean
  /** The viewer may apply it now: it's pending, and their roles allow its kind */
  canApply: boolean
  /** The running code knows its kind (an older or newer deploy might not); unknown kinds can't be applied */
  known: boolean
}

export type ProposalTone = "neutral" | "success" | "warning" | "danger" | "info"

/** How each status reads on the card and the Proposals page */
export const PROPOSAL_STATUS: Record<JackProposalStatusKey, { label: string; tone: ProposalTone }> = {
  PENDING: { label: "Waiting for an officer", tone: "warning" },
  APPLYING: { label: "Applying", tone: "info" },
  APPLIED: { label: "Applied", tone: "success" },
  DISCARDED: { label: "Discarded", tone: "neutral" },
  FAILED: { label: "Failed", tone: "danger" },
  STALE: { label: "Stale", tone: "neutral" },
  SUPERSEDED: { label: "Replaced", tone: "neutral" },
}

export const PROPOSAL_STATUSES = Object.keys(PROPOSAL_STATUS) as JackProposalStatusKey[]

export function isProposalStatus(value: unknown): value is JackProposalStatusKey {
  return typeof value === "string" && Object.hasOwn(PROPOSAL_STATUS, value)
}

/** Where officers see every proposal */
export const PROPOSALS_PAGE = "/admin/jack/proposals"

/** A room, scrolled to one of its messages (the anchor works once rooms support `?m=`) */
export function roomMessageUrl(roomId: string, messageId: string | null): string {
  return messageId ? `/admin/jack/${roomId}?m=${encodeURIComponent(messageId)}` : `/admin/jack/${roomId}`
}

export function proposalApiUrl(id: string): string {
  return `/api/admin/jack/proposals/${encodeURIComponent(id)}`
}

/** A site path a room note can end with: plain path characters only, so a quote or a space ends it */
const NOTE_PATH = /^\/(?![/\\])[A-Za-z0-9\-._~%/?=&#]*$/
const NOTE_LINK = /^([\s\S]*) → (\/(?![/\\])[A-Za-z0-9\-._~%/?=&#]*)$/

/**
 * A room note that points somewhere: "Dylan applied: Edit the page “Rules” → /admin/pages/…". Jack's
 * history reads it as written; the room links the path. A path that isn't a plain site path is left off
 */
export function noteWithLink(text: string, path: string | null | undefined): string {
  return path && isNotePath(path) ? `${text} → ${path}` : text
}

/** A plain site path ("/admin/pages/…") a note can link */
export function isNotePath(path: string): boolean {
  return NOTE_PATH.test(path)
}

/** The text and the site path of a note made by noteWithLink, or null for a note without one */
export function noteLink(note: string): { text: string; path: string } | null {
  const match = NOTE_LINK.exec(note)
  return match ? { text: match[1], path: match[2] } : null
}

/** The proposal's state as the card shows it: whichever copy is newest (by updatedAt, then by stage) */
export function latestProposalState(...copies: (JackProposalState | null | undefined)[]): JackProposalState | null {
  let best: JackProposalState | null = null
  for (const copy of copies) if (copy && (!best || isNewerProposalState(best, copy))) best = copy
  return best
}

/** How far along a status is, to break a tie between two copies from the same moment */
function stage(status: JackProposalStatusKey): number {
  return status === "PENDING" ? 0 : status === "APPLYING" ? 1 : 2
}

/** Whether `next` should replace `current`: newer wins, then further along, so a late copy never takes a proposal back */
export function isNewerProposalState(current: JackProposalState, next: JackProposalState): boolean {
  if (next.updatedAt !== current.updatedAt) return next.updatedAt > current.updatedAt
  return stage(next.status) > stage(current.status)
}
