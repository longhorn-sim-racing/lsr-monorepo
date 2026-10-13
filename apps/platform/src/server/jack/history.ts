import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { parseToolParts, type JackToolPart } from "@/lib/jack/parts"
import type { JackPersonaKey } from "@/lib/jack/types"
import { FORMER_OFFICER } from "./messages"

/** The fields of a JackMessage row the history needs (a JackMessageRow fits) */
export type HistoryRow = {
  id: string
  kind: "user" | "assistant" | "system"
  persona: JackPersonaKey | null
  content: string
  toolCalls: unknown
  status: "streaming" | "done" | "error"
  answeredById: string | null
  model: string | null
  createdAt: Date
  author: { displayName: string } | null
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
 *   Central Time timestamp, so several officers posting during one answer become one turn. Room
 *   notes (a persona switch) go in the turn they came before, as context.
 * - An earlier reply is its text plus a one-line note of the tools it used. Its thinking and raw
 *   tool calls aren't kept: each reply's own tool loop is append-only, and across replies the history
 *   is rebuilt as plain text, so no thinking block is ever replayed into a changed conversation.
 * - It's a pure function of the saved rows, so the same room builds the same bytes every time and
 *   the previous turns stay a cacheable prefix. Only the window start moves, and only in steps.
 */
export function buildHistory(rows: HistoryRow[], replyId: string, limits: HistoryLimits = HISTORY_LIMITS): BetaMessageParam[] {
  const sorted = [...rows].sort(byTime)
  const current = sorted.find((row) => row.id === replyId)
  const cutoff = current?.createdAt ?? new Date(8.64e15)

  type Turn = { reply: HistoryRow | null; items: HistoryRow[] }
  const replies = sorted.filter((row) => row.kind === "assistant" && row.id !== replyId && row.createdAt <= cutoff)
  const turns: Turn[] = [...replies.map((reply) => ({ reply, items: [] as HistoryRow[] })), { reply: null, items: [] }]
  const turnOf = new Map<string, number>(replies.map((reply, index) => [reply.id, index]))
  turnOf.set(replyId, turns.length - 1)

  for (const row of sorted) {
    if (row.kind === "user") {
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
  const entries: { role: "user" | "assistant"; text: string }[] = []
  turns.slice(start).forEach((turn, index) => {
    const lead = index === 0 && start > 0 ? `${EARLIER_LEFT_OUT}\n` : ""
    const officers = renderOfficerTurn(turn.items)
    if (officers || lead) entries.push({ role: "user", text: lead + officers })
    const reply = turn.reply ? renderReply(turn.reply) : ""
    if (reply) entries.push({ role: "assistant", text: reply })
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

  return merged.map(({ role, text }) => ({ role, content: text }))
}

function byTime(a: HistoryRow, b: HistoryRow) {
  const t = a.createdAt.getTime() - b.createdAt.getTime()
  return t !== 0 ? t : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function turnSize(turn: { reply: HistoryRow | null; items: HistoryRow[] }): number {
  return turn.items.reduce((sum, item) => sum + item.content.length + 40, 0) + (turn.reply ? renderReply(turn.reply).length : 0)
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

function renderOfficerTurn(items: HistoryRow[]): string {
  if (!items.length) return ""
  const lines = items.map((item) =>
    item.kind === "system" ? `(Room note: ${item.content})` : `${item.author?.displayName ?? FORMER_OFFICER}: ${item.content}`
  )
  return `[${formatTurnTime(items[items.length - 1].createdAt)}]\n${lines.join("\n")}`
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

/** One line per reply: which tools ran, with what input, and what came back (as labelled) */
export function toolNote(parts: JackToolPart[]): string {
  const used = parts.map((part) => {
    const input = part.input === null || part.input === undefined ? "" : ` ${clip(JSON.stringify(part.input), 300)}`
    const outcome = part.status === "error" ? `failed: ${part.error ?? part.label}` : part.label
    return `${part.name}${input} → ${outcome}`
  })
  return `[Tools used: ${used.join("; ")}]`
}
