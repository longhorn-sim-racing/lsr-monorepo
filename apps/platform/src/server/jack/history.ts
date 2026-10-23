import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { linkHost } from "@/lib/jack/links"
import { parseToolParts, type JackToolPart } from "@/lib/jack/parts"
import type { JackPersonaKey } from "@/lib/jack/types"
import { attachmentLine, type HistoryFile } from "./files/describe"
import { FORMER_OFFICER } from "./messages"
import { WEB_FETCH, WEB_SEARCH } from "./web-tools"

export type { HistoryFile } from "./files/describe"

/** The fields of a JackMessage row the history needs (a JackMessageRow fits) */
export type HistoryRow = {
  id: string
  kind: "user" | "assistant" | "system"
  persona: JackPersonaKey | null
  content: string
  toolCalls: unknown
  status: "streaming" | "done" | "error"
  answeredById: string | null
  /** Notes a reply answers, like an officer message: a deck's continue note, a scheduled run's question */
  continues?: boolean
  scheduled?: boolean
  model: string | null
  createdAt: Date
  author: { displayName: string } | null
  /**
   * Officer messages: who posted it as Jack reads it, snapshotted when it was posted
   * ("Gray (Technology Director · Technology · CS) [@gray-marshall]"). Older messages have none and
   * show the author's name
   */
  authorLabel?: string | null
  /** Officer messages: the READY files posted with it, in order */
  files?: HistoryFile[]
}

export type HistoryLimits = {
  /** Most exchanges (officer turn + reply) sent, counting the one being answered */
  maxTurns: number
  /** The window's start moves in steps this big, so it stays put (and cached) for several turns */
  turnStep: number
  /** Rough size cap for the whole history, in characters (about 4 per token) */
  maxChars: number
}

export const HISTORY_LIMITS: HistoryLimits = { maxTurns: 40, turnStep: 10, maxChars: 200_000 }

const EARLIER_LEFT_OUT = "(Earlier messages in this room aren't included.)"

/**
 * Builds the conversation a reply sends: the room as alternating turns, ending with the officer
 * messages this reply answers.
 *
 * - An officer turn is every message a reply answered (`answeredById`), as "Name: text" under a
 *   Central Time timestamp, so several officers posting during one answer become one turn. Notes a
 *   reply answers (a deck's continue note, a scheduled question) go in that reply's turn the same way;
 *   other room notes (a persona switch) go in the turn they came before, as context.
 * - A reply Claude didn't write (a "not connected" or "budget used up" notice, or a placeholder
 *   from before the model) is left out, so the questions it got carry into the next turn.
 * - An earlier reply is its text plus a one-line note of the tools it used. Its thinking and raw
 *   tool calls aren't kept: each reply's own tool loop is append-only, and across replies the history
 *   is rebuilt as plain text, so no thinking block is ever replayed into a changed conversation.
 * - It's a pure function of the saved rows, so the same room builds the same bytes every time and
 *   the previous turns stay a cacheable prefix. Only the window start moves, and only in steps.
 * - An officer's line is their label as it was when they posted (`authorLabel`), or their name for
 *   older messages. Under a message with files is a line naming each one by id (design §5); the
 *   files themselves go only with the turn being answered (buildConversation, then files/turn.ts).
 */
export function buildHistory(rows: HistoryRow[], replyId: string, limits: HistoryLimits = HISTORY_LIMITS): BetaMessageParam[] {
  return buildConversation(rows, replyId, limits).history
}

/** The history a reply sends, and the files posted in the turn it answers, which files/turn.ts adds to that turn */
export type Conversation = { history: BetaMessageParam[]; attached: HistoryFile[] }

/** buildHistory, plus the files the turn being answered carries */
export function buildConversation(rows: HistoryRow[], replyId: string, limits: HistoryLimits = HISTORY_LIMITS): Conversation {
  const sorted = [...rows].sort(byTime)
  const current = sorted.find((row) => row.id === replyId)
  const cutoff = current?.createdAt ?? new Date(8.64e15)

  type Turn = { reply: HistoryRow | null; items: HistoryRow[] }
  const replies = sorted.filter((row) => row.kind === "assistant" && row.id !== replyId && row.createdAt <= cutoff)
  const turns: Turn[] = [...replies.map((reply) => ({ reply, items: [] as HistoryRow[] })), { reply: null, items: [] }]
  const turnOf = new Map<string, number>(replies.map((reply, index) => [reply.id, index]))
  turnOf.set(replyId, turns.length - 1)

  for (const row of sorted) {
    // A note a reply answers goes in that reply's turn, like an officer message: a scheduled question
    // waiting behind officer messages isn't theirs to answer, and its own reply needs it
    if (row.kind === "user" || row.continues || row.scheduled) {
      const index = row.answeredById ? turnOf.get(row.answeredById) : undefined
      if (index !== undefined) turns[index].items.push(row)
    } else if (row.kind === "system") {
      // Notes with a model are Stand's usage records ("Stand named this room ..."), not context
      if (row.model || row.createdAt > cutoff) continue
      const index = turns.findIndex((turn) => !turn.reply || turn.reply.createdAt >= row.createdAt)
      turns[index].items.push(row)
    }
  }

  const start = windowStart(turns.map(turnSize), limits)
  const shown = turns.slice(start)
  const replyTexts = shown.map((turn) => (turn.reply && !isNotice(turn.reply) ? renderReply(turn.reply) : ""))
  // Every turn after the last reply Claude wrote merges into the turn being answered (a notice's
  // questions carry over), so their files are the ones it shows
  const lastReply = replyTexts.findLastIndex(Boolean)
  const attached: HistoryFile[] = []
  const entries: { role: "user" | "assistant"; text: string }[] = []
  shown.forEach((turn, index) => {
    const current = index > lastReply
    const lead = index === 0 && start > 0 ? `${EARLIER_LEFT_OUT}\n` : ""
    const officers = renderOfficerTurn(turn.items, current)
    if (current) attached.push(...turn.items.flatMap((item) => (item.kind === "user" ? (item.files ?? []) : [])))
    if (officers || lead) entries.push({ role: "user", text: lead + officers })
    if (replyTexts[index]) entries.push({ role: "assistant", text: replyTexts[index] })
  })

  // Same-role neighbors (a reply that said nothing, an officer turn with no messages) merge
  const merged: { role: "user" | "assistant"; text: string }[] = []
  for (const entry of entries) {
    const last = merged.at(-1)
    if (last?.role === entry.role) last.text += `\n\n${entry.text}`
    else merged.push({ ...entry })
  }
  while (merged[0]?.role === "assistant") merged.shift()
  if (merged.at(-1)?.role !== "user") merged.push({ role: "user", text: "(No new messages.)" })

  return { history: merged.map(({ role, text }) => ({ role, content: text })), attached }
}

function byTime(a: HistoryRow, b: HistoryRow) {
  const t = a.createdAt.getTime() - b.createdAt.getTime()
  return t !== 0 ? t : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function turnSize(turn: { reply: HistoryRow | null; items: HistoryRow[] }): number {
  const items = turn.items.reduce((sum, item) => sum + item.content.length + 40 + (item.authorLabel?.length ?? 0) + (item.files?.length ?? 0) * 120, 0)
  return items + (turn.reply && !isNotice(turn.reply) ? renderReply(turn.reply).length : 0)
}

/** Index of the first turn sent: the last `maxTurns`, cut further while the history is too big. Always keeps the newest */
export function windowStart(sizes: number[], limits: HistoryLimits = HISTORY_LIMITS): number {
  const last = sizes.length - 1
  const { maxTurns, turnStep, maxChars } = limits
  let start = sizes.length > maxTurns ? Math.ceil((sizes.length - maxTurns) / turnStep) * turnStep : 0
  const total = (from: number) => sizes.slice(from).reduce((sum, size) => sum + size, 0)
  while (start < last && total(start) > maxChars) start = Math.min(start + turnStep, last)
  return Math.min(start, last)
}

const turnTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
})

/** "Tue, Oct 13, 2026, 3:05 PM CT" */
export function formatTurnTime(date: Date): string {
  return `${turnTime.format(date).replace(/ /g, " ")} CT`
}

/** `current`: the turn being answered, whose files follow it */
function renderOfficerTurn(items: HistoryRow[], current: boolean): string {
  if (!items.length) return ""
  const lines = items.flatMap((item) => {
    if (item.kind === "system") return [`(Room note: ${item.content})`]
    const line = `${officerName(item)}:${item.content ? ` ${item.content}` : ""}`
    return item.files?.length ? [line, attachmentLine(item.files, { current })] : [line]
  })
  return `[${formatTurnTime(items[items.length - 1].createdAt)}]\n${lines.join("\n")}`
}

/**
 * Who wrote an officer message: the label it was posted with ("Gray (Technology Director · Technology ·
 * CS) [@gray-marshall]"), or the name for messages from before labels. Once the account is deleted,
 * "Former officer", as the room shows it
 */
function officerName(item: HistoryRow): string {
  if (!item.author) return FORMER_OFFICER
  return item.authorLabel?.trim() || item.author.displayName
}

/** A finished reply with no model never reached Claude: a notice, or a pre-model placeholder */
function isNotice(reply: HistoryRow): boolean {
  return reply.status === "done" && !reply.model
}

function renderReply(reply: HistoryRow): string {
  const parts = parseToolParts(reply.toolCalls)
  let text = reply.content.trim()
  if (reply.status === "error") text = text ? `${text}\n[This reply stopped early.]` : "[This reply failed before it said anything.]"
  const note = parts.length ? toolNote(parts) : ""
  return [text, note].filter(Boolean).join("\n\n")
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * One line per reply: which tools ran, with what input, and what came back (as labelled). Web searches
 * and fetches are in it too (parts named web_search and web_fetch): a search with its query and the sites
 * of the pages the reply cited, a fetch with only its label ("Read fia.com"), so a later turn knows the
 * reply used the web and where it looked. The links themselves aren't: web_fetch couldn't open a link
 * from here anyway, so web_links returns them instead
 */
export function toolNote(parts: JackToolPart[]): string {
  const used = parts.map((part) => {
    const input = part.input === null || part.input === undefined || part.name === WEB_FETCH ? "" : ` ${clip(JSON.stringify(part.input), 300)}`
    const outcome = part.status === "error" ? `failed: ${part.error ?? part.label}` : part.label
    const hosts = [...new Set(citedPages(part).map((source) => linkHost(source.url) ?? "").filter(Boolean))]
    const sites = hosts.length ? ` (cited: ${hosts.slice(0, 5).join(", ")}${hosts.length > 5 ? ", …" : ""})` : ""
    return `${part.name}${input} → ${outcome}${sites}`
  })
  return `[Tools used: ${used.join("; ")}]`
}

/** The pages a web search part lists: the ones its reply cited */
function citedPages(part: JackToolPart) {
  if (part.name !== WEB_SEARCH) return []
  return (Array.isArray(part.displays) ? part.displays : []).flatMap((display) => (display.kind === "web_sources" && Array.isArray(display.sources) ? display.sources : []))
}
