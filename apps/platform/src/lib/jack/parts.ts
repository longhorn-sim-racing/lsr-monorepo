/**
 * What a reply shows besides its text: the tools Jack used and what came back (#161). Plain JSON only;
 * these are saved in JackMessage.toolCalls, sent over Realtime and rendered by client components.
 */

export type JackCellValue = string | number | boolean | null

/** A chart Jack drew. Rows are the data; `xKey` names the category column and each series a value column. */
export type JackChartSpec = {
  type: "bar" | "line" | "pie"
  title: string
  xKey: string
  series: { key: string; label: string }[]
  rows: Record<string, JackCellValue>[]
  /** Label for the value axis (bar and line) */
  yLabel?: string
}

/** One thing a tool shows in the room. A tool can return several (e.g. the SQL it ran and the rows). */
export type JackToolDisplay =
  | { kind: "sql"; sql: string; rowCount: number; ms: number; truncated: boolean }
  | { kind: "table"; columns: string[]; rows: JackCellValue[][]; truncated: boolean; caption?: string }
  | { kind: "chart"; chart: JackChartSpec }
  | { kind: "event_draft"; eventId: string; title: string; startsAt: string; endsAt: string; venue: string | null; editUrl: string }
  | { kind: "note"; text: string }
  | JackDeckDisplay
  | JackProposalDisplay
  | JackLinksDisplay
  | JackTextDraftDisplay
  | JackStatsDisplay
  | JackFilesDisplay
  | JackWebSourcesDisplay

/*
 * Jack 2.0's display kinds (#188, design §7.5). Every outside link a part shows has its destination
 * host beside it, read from the URL itself (a `host` field is never trusted for that).
 */

/**
 * A change Jack proposed (design §4): small, to stay well under Realtime's message limit. The card loads
 * the full diff and the live status from the proposal itself (G4); this is only what the reply showed
 */
export type JackProposalDisplay = {
  kind: "proposal"
  proposalId: string
  /** The proposal's kind, e.g. "event.update" (`kind` already says which display this is) */
  proposalKind: string
  title: string
  summary: string
  /** e.g. { matched: 12, unmatched: 2 } for list kinds */
  counts?: Record<string, number>
  /**
   * The first few changed fields, formatted on the server and cut short. A markdown row (long text) has
   * no before, and a count of changed lines as its after; the card loads the real diff
   */
  preview: { label: string; before: string | null; after: string | null; format?: "text" | "value" | "markdown" }[]
}

/** A link in a `links` part */
export type JackLinkItem = {
  title: string
  /** A web link or a site path ("/admin/…") */
  url: string
  /** e.g. "Updated Oct 3" or "PDF · 2 pages" */
  meta?: string
  snippet?: string
  /** What the tool thinks the host is; the room shows the host it reads from `url` instead */
  host?: string
}

/** Links a tool found: search results, documents, pages */
export type JackLinksDisplay = { kind: "links"; items: JackLinkItem[]; caption?: string }

/** A draft for an officer to copy and send themselves (draft_text): Jack never sends it */
export type JackTextDraftDisplay = {
  kind: "text_draft"
  draftKind: "email" | "agenda" | "caption" | "text"
  /** Emails */
  subject?: string
  /** Emails: who it's meant for, as written ("Sponsorship team at Acme") */
  to?: string
  body: string
}

/** A few headline numbers as tiles */
export type JackStatsDisplay = { kind: "stats"; items: { label: string; value: string | number; hint?: string }[] }

/** JackFile.kind */
export type JackFileKindKey = "IMAGE" | "PDF" | "SPREADSHEET" | "CSV" | "JSON" | "TEXT" | "DOCUMENT" | "TRANSCRIPT" | "OTHER"

/** A file in a room: an officer's upload, or one a tool made */
export type JackFileItem = {
  id: string
  filename: string
  kind: JackFileKindKey
  sizeBytes: number
  /** Where to open it: the officer-only file route (/api/admin/jack/files/…) */
  url: string
  /** A small preview, for images: a site path (the file route). Anything else isn't shown */
  thumbUrl?: string
}

export type JackFilesDisplay = { kind: "files"; files: JackFileItem[] }

/** What a web search looked for and the pages the answer cites or links to (G8; web-tools.ts) */
export type JackWebSourcesDisplay = {
  kind: "web_sources"
  queries: string[]
  sources: { title: string; url: string; host: string }[]
}

/**
 * A deck or graphic Jack made or changed (#177): the room shows its slides as thumbnails at `version`
 * and links to the deck page. `focus` lists the slides this call wrote, edited or rendered
 */
export type JackDeckDisplay = {
  kind: "deck"
  deckId: string
  title: string
  size: "slides" | "post" | "story" | "square"
  version: number
  slideIds: string[]
  focus?: string[]
}

/** A tool call inside a reply, saved in order in JackMessage.toolCalls */
export type JackToolPart = {
  /** The model's tool_use id */
  id: string
  /** The tool's name, e.g. "run_sql" */
  name: string
  /** A short human summary, e.g. "Ran a query (13 rows)" or "Drafted General Meeting 1" */
  label: string
  status: "running" | "done" | "error"
  /** Where the call happened in the reply: the number of characters of the message text before it */
  at: number
  /** The input the model sent, shown collapsed for the curious */
  input: unknown
  displays: JackToolDisplay[]
  error?: string
  /** How long the tool took */
  ms?: number
}

/** Reads JackMessage.toolCalls defensively (it's JSON from the database) */
export function parseToolParts(value: unknown): JackToolPart[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (part): part is JackToolPart =>
      typeof part === "object" && part !== null && typeof (part as JackToolPart).id === "string" && typeof (part as JackToolPart).name === "string",
  )
}
