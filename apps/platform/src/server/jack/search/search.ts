import { SEARCH_SOURCES } from "./registry"
import type { SearchHit, SearchSource } from "./types"

/**
 * One search over many sources (design §7.1): each named source (or every default one) is searched
 * at once for up to `limit` hits, and the hits merge by rank, newest first on a tie. A source that's
 * switched off says so, and one that fails is reported without failing the others.
 */

export type SearchOptions = {
  query: string
  /** Source keys to search; every default source when absent or empty */
  sources?: string[]
  limit: number
  includeJackReplies?: boolean
  signal?: AbortSignal
  /** The sources to pick from (tests); SEARCH_SOURCES by default */
  registry?: SearchSource[]
}

/** What happened in each source searched */
export type SourceOutcome =
  | { source: string; status: "searched"; hits: number }
  | { source: string; status: "unavailable"; reason: string }
  | { source: string; status: "failed"; reason: string }

export type SearchResult = { hits: SearchHit[]; outcomes: SourceOutcome[] }

/** Higher rank first; then newer; then the order the sources are listed in (sort is stable) */
function byRank(a: SearchHit, b: SearchHit): number {
  if (b.rank !== a.rank) return b.rank - a.rank
  return (b.date ?? "").localeCompare(a.date ?? "")
}

export function sourcesFor(names: string[] | undefined, registry: SearchSource[] = SEARCH_SOURCES): SearchSource[] {
  return names?.length ? registry.filter((source) => names.includes(source.key)) : registry.filter((source) => source.byDefault)
}

export async function search({ query, sources, limit, includeJackReplies = false, signal, registry = SEARCH_SOURCES }: SearchOptions): Promise<SearchResult> {
  const chosen = sourcesFor(sources, registry)
  const results = await Promise.all(
    chosen.map(async (source): Promise<{ outcome: SourceOutcome; hits: SearchHit[] }> => {
      try {
        const reason = await source.unavailable?.()
        if (reason) return { outcome: { source: source.key, status: "unavailable", reason }, hits: [] }
        const hits = await source.search({ query, limit, includeJackReplies, signal })
        return { outcome: { source: source.key, status: "searched", hits: hits.length }, hits }
      } catch (error) {
        console.error(`[jack] Searching ${source.key} failed:`, error)
        return { outcome: { source: source.key, status: "failed", reason: "It couldn't be searched just now." }, hits: [] }
      }
    }),
  )
  const hits = results
    .flatMap((result) => result.hits)
    .sort(byRank)
    .slice(0, limit)
  return { hits, outcomes: results.map((result) => result.outcome) }
}
