/**
 * Jack's unified search (#188, design §7.1): one `search` over every full-text index and one `read`
 * for whatever it finds. Each source (knowledge, documents, rooms, site content, Teams, and Discord
 * from its own track) returns hits in the same shape, and the hits from every source merge by rank.
 */

/** Small facts about a hit or a document, for the model and the room ("author", "room", "tags") */
export type SearchMeta = Record<string, string | number | boolean | null>

/** One search result, the same shape from every source */
export type SearchHit = {
  /** The source that found it: "knowledge", "documents", "rooms", "site", "teams" */
  source: string
  /** What `read` takes as its type for this hit: "knowledge", "post", "room_message", … */
  type: string
  /** What `read` takes as its id */
  id: string
  title: string
  /** A console path ("/admin/…"), a public site path ("/news/…") or an outside link (shown with its host) */
  url: string
  /** The passage that matched, as plain text */
  snippet: string
  /** When it was written or last changed (ISO), or null */
  date: string | null
  meta: SearchMeta
  /** Full-text rank from 0 to 1 (ts_rank_cd, normalization 32); hits from every source merge by it */
  rank: number
}

/** What every source is asked */
export type SearchRequest = {
  /** What was typed: words, "a phrase", or, -word (websearch_to_tsquery) */
  query: string
  /** The most hits this source returns */
  limit: number
  /** Rooms: also search Jack's own earlier answers (labelled "not a source") */
  includeJackReplies: boolean
  /** The reply searching, when Jack searches: rooms leave out the messages it's answering (the question itself) */
  replyId?: string
  signal?: AbortSignal
}

/** One whole thing `read` returns, before paging */
export type ReadDoc = {
  type: string
  id: string
  title: string
  url: string
  date: string | null
  meta: SearchMeta
  /** Plain text or Markdown; "#" headings make the outline */
  text: string
}

export type ReadResult = { ok: true; doc: ReadDoc } | { ok: false; error: string }

/** Reads one kind of thing by id, for `read` */
export type SearchReader = {
  /** The `type` `read` takes, e.g. "knowledge" */
  type: string
  /** For the tool description: what the id is */
  description: string
  read(id: string, options: { signal?: AbortSignal }): Promise<ReadResult>
}

/** One searchable source. Registered in a track's slot (search/slots/<track>.ts) */
export type SearchSource = {
  /** Stable, what the `sources` filter takes: "knowledge" */
  key: string
  /** For the tool description: what it covers */
  description: string
  /** Searched when a call doesn't name its sources */
  byDefault: boolean
  /** Null when it can be searched; otherwise why not, e.g. "Teams isn't connected". Read every call, never cached */
  unavailable?(): Promise<string | null>
  search(request: SearchRequest): Promise<SearchHit[]>
  /** The types `read` opens for this source's hits */
  readers: SearchReader[]
}
