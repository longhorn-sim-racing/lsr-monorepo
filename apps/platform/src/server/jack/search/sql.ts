import { Prisma } from "@prisma/client"

/**
 * SQL shared by the search sources. Queries go through websearch_to_tsquery, which takes what was
 * typed as is (quotes for a phrase, "or", -word to leave one out) and never fails on odd input.
 */

/** ts_headline's options: two short fragments, no markup (snippets are plain text) */
export const HEADLINE_OPTIONS = 'MaxFragments=2, MaxWords=28, MinWords=10, StartSel="", StopSel="", FragmentDelimiter=" … "'

/** The longest text ts_headline reads for one hit (it parses the whole input, so big documents are cut first) */
export const HEADLINE_INPUT_CHARS = 20_000

/** `q.query` in a search: the parsed query as a one-row CTE */
export function queryCte(query: string): Prisma.Sql {
  return Prisma.sql`q AS (SELECT websearch_to_tsquery('english', ${query}) AS query)`
}

/** The longest snippet a hit keeps, in characters */
export const SNIPPET_MAX = 320

/** A snippet from ts_headline, on one line and capped */
export function cleanSnippet(text: string | null | undefined): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim()
  return flat.length > SNIPPET_MAX ? `${flat.slice(0, SNIPPET_MAX - 1)}…` : flat
}

/** ts_rank_cd comes back as a float4; keep it a plain number in 0..1 */
export function rankOf(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0
}

export function isoOrNull(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null
}
