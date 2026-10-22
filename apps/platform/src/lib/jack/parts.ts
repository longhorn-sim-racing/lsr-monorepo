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
