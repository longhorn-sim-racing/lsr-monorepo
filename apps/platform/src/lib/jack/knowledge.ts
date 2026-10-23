/**
 * The knowledge base's shared rules (#188, design §9): limits, tags and an entry's age. Pure, so the
 * Knowledge page, Jack's knowledge tool and the seed loader all read entries the same way.
 */

export const KNOWLEDGE_LIMITS = {
  titleMax: 120,
  /** An entry written on the Knowledge page or loaded from the seed */
  bodyMax: 20_000,
  /** One Jack saves or rewrites in a room: a knowledge entry is a short note, not a document */
  jackBodyMax: 8_000,
  tagsMax: 10,
  tagMax: 40,
  sourceNoteMax: 300,
  sourceUrlMax: 500,
} as const

/** Jack mentions an entry's age past this many days, and the page flags it (design §9) */
export const KNOWLEDGE_STALE_DAYS = 180

/** "Who does what", "Decision log" → "who-does-what", "decision-log": lowercase words joined by dashes, deduped */
export function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = []
  for (const tag of tags) {
    const clean = tag
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/[\s-]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, KNOWLEDGE_LIMITS.tagMax)
    if (clean && !out.includes(clean)) out.push(clean)
  }
  return out.slice(0, KNOWLEDGE_LIMITS.tagsMax)
}

/** What an entry's age counts from: when an officer last reviewed it, else when its source said it, else its last edit */
export type KnowledgeAgeBasis = "reviewed" | "source" | "updated"

export type KnowledgeAge = { days: number; basis: KnowledgeAgeBasis; since: Date; stale: boolean }

/** Age = now − (reviewedAt ?? sourceDate ?? updatedAt), in whole days (design §3.3) */
export function knowledgeAge(entry: { reviewedAt: Date | null; sourceDate: Date | null; updatedAt: Date }, now: Date = new Date()): KnowledgeAge {
  const [since, basis]: [Date, KnowledgeAgeBasis] = entry.reviewedAt
    ? [entry.reviewedAt, "reviewed"]
    : entry.sourceDate
      ? [entry.sourceDate, "source"]
      : [entry.updatedAt, "updated"]
  const days = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 86_400_000))
  return { days, basis, since, stale: days > KNOWLEDGE_STALE_DAYS }
}

/** "today", "3 days", "5 weeks", "7 months", "2 years" */
export function formatAge(days: number): string {
  if (days < 1) return "today"
  if (days < 14) return `${days} day${days === 1 ? "" : "s"}`
  if (days < 60) return `${Math.floor(days / 7)} weeks`
  if (days < 730) return `${Math.floor(days / 30.44)} months`
  return `${Math.floor(days / 365.25)} years`
}

/** "Reviewed 3 days ago", "From a source 7 months old", "Last edited today" */
export function describeAge(age: KnowledgeAge): string {
  const ago = age.days < 1 ? "today" : `${formatAge(age.days)} ago`
  if (age.basis === "reviewed") return `Reviewed ${ago}`
  if (age.basis === "source") return age.days < 1 ? "Source dated today" : `Source dated ${ago}`
  return `Last edited ${ago}`
}

/** The Knowledge page's link for an entry */
export function knowledgeEntryPath(id: string): string {
  return `/admin/knowledge/${id}`
}

/** Where Jack's latest save or edit of an entry came from (KnowledgeEntry.provenance) */
export type KnowledgeProvenance = {
  roomId: string
  /** The reply that saved it */
  replyId: string | null
  /** The officer messages that reply answered */
  messageIds: string[]
  /** The officer whose message started the reply */
  askedBy: { userId: string | null; name: string }
  /** The tools the reply used before saving, outside sources included: each one's input (cut short) and what came back */
  tools: { name: string; input: string; label: string }[]
  /** ISO timestamp */
  at: string
}

const isString = (value: unknown): value is string => typeof value === "string"

/** Reads KnowledgeEntry.provenance defensively (it's JSON from the database), or null */
export function parseProvenance(value: unknown): KnowledgeProvenance | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const p = value as Record<string, unknown>
  if (!isString(p.roomId) || !isString(p.at)) return null
  const askedBy = (p.askedBy ?? {}) as Record<string, unknown>
  return {
    roomId: p.roomId,
    replyId: isString(p.replyId) ? p.replyId : null,
    messageIds: Array.isArray(p.messageIds) ? p.messageIds.filter(isString) : [],
    askedBy: { userId: isString(askedBy.userId) ? askedBy.userId : null, name: isString(askedBy.name) ? askedBy.name : "An officer" },
    tools: Array.isArray(p.tools)
      ? p.tools
          .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
          .map((t) => ({ name: String(t.name ?? ""), input: String(t.input ?? ""), label: String(t.label ?? "") }))
          .filter((t) => t.name)
      : [],
    at: p.at,
  }
}

/** A room message's link: the room, scrolled to the message once rooms take anchors (?m=) */
export function roomMessagePath(roomId: string, messageId?: string | null): string {
  return messageId ? `/admin/jack/${roomId}?m=${encodeURIComponent(messageId)}` : `/admin/jack/${roomId}`
}

/**
 * Exact find-and-replace edits on an entry's text, all or none: each `find` must appear exactly once
 * (in the text as the edits before it left it)
 */
export function applyTextEdits(text: string, edits: readonly { find: string; replace: string }[]): { text: string } | { error: string } {
  let out = text
  for (const [i, edit] of edits.entries()) {
    const where = `Edit ${i + 1}`
    if (!edit.find) return { error: `${where}: find can't be empty.` }
    const count = out.split(edit.find).length - 1
    if (count === 0) return { error: `${where}: the find text isn't in the entry. Copy it exactly from the entry as you read it.` }
    if (count > 1) return { error: `${where}: the find text appears ${count} times. Add more of the text around it so it's unique.` }
    out = out.replace(edit.find, () => edit.replace)
  }
  return { text: out }
}
