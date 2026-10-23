import type { z } from "zod"
import type { JackProposalLink, JackProposalResult } from "@/lib/jack/types"

/**
 * Proposed changes (#188, design §4). Jack proposes; an officer presses Apply. A `propose_*` tool
 * validates its input against a kind's schema, the kind describes the change on the server (the model
 * never writes the title, summary or diff), and the change itself runs only when an officer applies it,
 * with that officer's permissions. The claim/apply framework is `./service.ts`; these types are what
 * every kind is written against. How a track adds a kind: docs/jack-2/tracks/groundwork.md.
 *
 * Plain JSON only in ProposalView, ProposalRow and ProposalResult: they're saved on JackProposal and
 * sent to the room.
 */

/** Who may apply a proposal of this kind, checked against the applying officer's roles (the same rule as the admin page) */
export type ProposalPermission = "officer" | "admin"

/**
 * The propose_* tools (design §7.1). Each kind names the one tool that offers it; the tool builds its
 * input and description from `kindsForTool()`, so a track adds a kind without editing another track's
 * tool file
 */
export const PROPOSE_TOOLS = [
  "propose_change",
  "propose_content",
  "propose_message",
  "propose_import",
  "propose_discord",
  "propose_deck_publish",
  "propose_meeting",
  "propose_recurring",
] as const

export type ProposeToolName = (typeof PROPOSE_TOOLS)[number]

/** One field a proposal changes, formatted on the server for the card */
export type ProposalDiffRow = {
  /** The payload field, e.g. "startsAtUtc" */
  field: string
  /** What officers call it, e.g. "Start time" */
  label: string
  /** As it is now, formatted ("Mon Oct 19, 6:00 PM CT"); null when it isn't set */
  before: string | null
  /** As it would be; null when the change clears it */
  after: string | null
  /** text: short plain text. value: one formatted value (a time, money, a count). markdown: long text, which the card diffs line by line */
  format: "text" | "value" | "markdown"
}

/**
 * One row of a proposal with rows (check-ins, imports, notification audiences). The card gives each a
 * checkbox, so an officer can apply some rows and not others
 */
export type ProposalRow = {
  /** Stable within the proposal: `selectedRows` lists these ids */
  id: string
  /** e.g. the name as written in the officer's list */
  label: string
  /** e.g. the member it matched, or why it didn't */
  detail?: string
  /** How the server matched the row to club data; the card starts unmatched and ambiguous rows unchecked */
  status?: "matched" | "ambiguous" | "unmatched"
}

/** A person the change affects (registrants, recipients, drivers), shown on the card */
export type ProposalPerson = { name: string; detail?: string }

/** A link on the card or in the result. Site paths ("/admin/events/…") or outside URLs, which show their host */
export type ProposalLink = JackProposalLink

/** What the card shows, built on the server by `prepare()` */
export type ProposalView = {
  /** e.g. "Change GM 2's start time" */
  title: string
  /** One or two plain sentences on what applying does */
  summary: string
  /** The fields that change; empty for kinds that only create (a news post) or only list rows */
  diff: ProposalDiffRow[]
  people?: ProposalPerson[]
  links?: ProposalLink[]
  /**
   * The rows to pick from, for kinds whose rows `prepare()` builds on the server (an import's file rows,
   * a notification's audience, names matched to members). Saved with the proposal: Apply checks the
   * officer's picks against these and passes them as `selectedRows`. A kind can give its rows here
   * alone, without `list`; when it has both, these win
   */
  rows?: ProposalRow[]
}

/**
 * What applying did: saved on JackProposal.result, posted in the room note ("Dylan applied: …") and sent
 * with the proposal.updated room event. Defined with the room types, since the page reads it too:
 * { summary, links?, created?, appliedRows?, counts? }
 */
export type ProposalResult = JackProposalResult

/** Where a proposal is being made and for whom: what `prepare()` gets */
export type ProposalContext = {
  roomId: string
  /** The reply proposing it; absent outside a room reply (scripts, the eval) */
  messageId?: string
  /** The officer it's proposed for (the asker); userId null outside a room reply */
  officer: { userId: string | null; displayName: string }
  signal?: AbortSignal
}

/** Who is applying and what they picked: what `apply()` gets */
export type ProposalApplyContext = {
  /** The officer who pressed Apply (not necessarily the one it was proposed for); the audit entry is theirs */
  officer: { userId: string; displayName: string }
  proposalId: string
  roomId: string
  /** Proposals with rows (`view.rows` or `list.rows`): the row ids the officer left checked; undefined means every row */
  selectedRows?: string[]
  /**
   * Derived from the proposal id ("proposal:<id>"), the same on every try. Pass it to outside services
   * (Resend's Idempotency-Key, Discord's dedupeKey) so a retried apply never sends twice
   */
  idempotencyKey: string
  /**
   * What `prepare()` snapshotted, the same value `checkStale()` just passed. A kind can make its write
   * conditional on it (the page service's `expected`), closing the gap between the check and the write;
   * throw StaleProposalError (./errors) when that write misses
   */
  before: unknown
  /** For the audit entry of the change itself (the service the kind calls writes it): links it back to the proposal */
  auditMetadata: ProposalAuditMetadata
}

/** Added to every audit entry a proposal leads to: the framework's own (entityType JACK_PROPOSAL) and the change's */
export type ProposalAuditMetadata = {
  via: "jack"
  proposalId: string
  roomId: string
  /** The officer it was proposed for (the asker); null outside a room reply */
  proposedFor: string | null
}

/** What `prepare()` returns: a snapshot of the target as it is now, and the card */
export type ProposalPrepared = {
  /** Only the fields in the payload, as they are now; `checkStale` compares against it at apply time */
  before: unknown
  view: ProposalView
  /** The record it changes (JackProposal.targetId), with `targetType`; a newer proposal for the same kind and target supersedes this one */
  targetId?: string
  /**
   * For kinds built from a room file: its sha256, checked again before applying. The payload must then
   * name the file as `fileId` (a JackFile id): Apply compares that file's sha256 with this one
   */
  fileSha256?: string
}

/**
 * One kind of change (design §4.2). Registered in `proposals/kinds/<track>.ts`.
 * - `tool` and `description` are how the model reaches it: the named propose_* tool lists every kind
 *   that names it, in registry order.
 * - `prepare` only reads: it describes the change and snapshots `before`.
 * - `checkStale` runs right before `apply`, outside any transaction, and returns why the proposal is
 *   stale ("GM 2's start time changed since this was proposed") or null.
 * - `apply` makes the change through the same services the admin pages use. It must be safe to retry
 *   with the same idempotency key.
 */
export type ProposalKind<P> = {
  /** Stable, saved on JackProposal.kind: "event.update" */
  kind: string
  /** The propose_* tool that offers it */
  tool: ProposeToolName
  /** What it changes and when to use it, written for the model (the tool's description includes it) */
  description: string
  /** Validates the payload when proposed and again at apply time */
  schema: z.ZodType<P>
  /** AuditLog entityType of what it changes, e.g. "Event" */
  targetType?: string
  permission: ProposalPermission
  /**
   * When some payloads need more than `permission` (an import into an admin-only target): the
   * permission for this payload. Checked before the claim and for the card's Apply button; it can only
   * make `permission` stricter, and one that throws means admin
   */
  permissionFor?(p: P): ProposalPermission
  /** Applying it can't be taken back (it sends, posts or deletes): the card asks the officer to confirm first */
  destructive?: boolean
  /**
   * For kinds whose rows come from the payload alone: rebuilds them, so the card can offer per-row
   * checkboxes (partial approval). Kinds that build rows on the server give them in `view.rows` instead
   */
  list?: { rows(p: P): ProposalRow[] }
  prepare(p: P, ctx: ProposalContext): Promise<ProposalPrepared>
  checkStale(p: P, before: unknown): Promise<string | null>
  apply(p: P, ctx: ProposalApplyContext): Promise<ProposalResult>
}

/** Lets a list hold kinds with different payload types */
export type AnyProposalKind = ProposalKind<any> // eslint-disable-line @typescript-eslint/no-explicit-any

/** One row of an officer's file, as cell text by target column key (after the officer's column map) */
export type ImportCells = Record<string, string>

/** A column an import target takes; the file's columns are mapped onto these */
export type ImportColumn = {
  /** Stable key, e.g. "email" */
  key: string
  /** e.g. "Email" */
  label: string
  required?: boolean
  /** Helps the model map columns, e.g. "The driver's UT email or personal email" */
  description?: string
}

/** What `validateRow` found: the value `applyRows` takes, or why the row can't be imported */
export type ImportRowCheck<R> =
  | { ok: true; value: R; label: string; detail?: string; status?: ProposalRow["status"] }
  | { ok: false; label: string; error: string }

/**
 * Where an `import.rows` proposal can put a file's rows (design §4.3): LSC applications, prospects,
 * action items. Registered in `proposals/import-targets/<track>.ts`.
 *
 * The `import.rows` kind (changes track) does the generic part: it reads the room file, applies the
 * officer's column map, calls `validateRow` for each row to build the card's rows (a failed check
 * becomes an unmatched row with its error as the detail), and at apply time reads the file again,
 * re-validates, keeps the rows the officer selected and hands the valid ones to `applyRows`.
 * A target only knows its own table.
 *
 * Kinds find targets through `proposals/import-targets` (its own registry), never through the kinds
 * registry, which would be an import cycle.
 */
export type ImportTarget<R> = {
  /** Stable key, the `target` in an import.rows payload, e.g. "lsc_application" */
  target: string
  /** e.g. "LSC applications" */
  label: string
  /**
   * Who may apply an import into it, when that's stricter than the import.rows kind's own permission
   * (the stricter one applies: import.rows returns it from its `permissionFor`)
   */
  permission?: ProposalPermission
  columns: ImportColumn[]
  /** Checks one row and resolves what it refers to (a member by email, say). Reads only; runs at propose time and again at apply */
  validateRow(row: ImportCells): Promise<ImportRowCheck<R>>
  /** Writes the valid, selected rows (`rowId` = the ProposalRow id) and says what it did */
  applyRows(rows: { rowId: string; value: R }[], ctx: ProposalApplyContext): Promise<ProposalResult>
}

/** Lets a list hold targets with different row types */
export type AnyImportTarget = ImportTarget<any> // eslint-disable-line @typescript-eslint/no-explicit-any
