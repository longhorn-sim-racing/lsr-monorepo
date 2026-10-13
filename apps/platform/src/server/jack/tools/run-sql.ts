import { z } from "zod"
import type { JackToolDisplay } from "@/lib/jack/parts"
import { getJackSqlClient, JACK_SQL_MISSING } from "@/server/jack/sql-client"
import { fitRows, toCell, toGrid } from "./cells"
import type { JackTool, JackToolResult } from "./types"

/**
 * run_sql: Jack writes his own SELECT (#161). It runs as `jack_readonly`, whose grants are the real
 * guard (read-only, public tables only, no SystemSetting). The checks here only catch obvious
 * mistakes early and keep the result small.
 */

export const MAX_SQL_ROWS = 200
export const MAX_SQL_MODEL_CHARS = 20_000
export const SQL_TABLE_DISPLAY_ROWS = 50
const DISPLAY_CELL_CHARS = 200
const STATEMENT_TIMEOUT = "5s"

/** Leading whitespace, comments and opening parentheses, which can come before the first keyword */
const LEAD = /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\()*/

export function prepareSql(raw: string): { ok: true; sql: string } | { ok: false; error: string } {
  let sql = raw.trim()
  while (sql.endsWith(";")) sql = sql.slice(0, -1).trimEnd()
  if (!sql) return { ok: false, error: "The query is empty. Send one SELECT statement." }
  const head = sql.replace(LEAD, "")
  if (!/^(select|with)\b/i.test(head)) {
    return {
      ok: false,
      error: "Only a single read-only query is allowed: it must start with SELECT or WITH. Jack can't change data with SQL (draft_event is the one write).",
    }
  }
  return { ok: true, sql }
}

/** Caps the rows in the database: one more than the cap, to tell whether more matched. The newline keeps a trailing -- comment from swallowing the wrapper. */
export function wrapSql(sql: string): string {
  return `SELECT * FROM (\n${sql}\n) AS jack_q LIMIT ${MAX_SQL_ROWS + 1}`
}

type PrismaLikeError = { code?: string; errorCode?: string; meta?: { code?: string; message?: string }; message?: string; name?: string }

/** Postgres's own message, made useful to the model; permission errors say the table is off-limits */
export function describeSqlError(error: unknown): string {
  const e = (error ?? {}) as PrismaLikeError
  const pgCode = e.meta?.code
  const text = (e.meta?.message ?? e.message ?? String(error)).replace(/^ERROR:\s*/, "").trim()

  if (e.name === "PrismaClientInitializationError" || e.errorCode?.startsWith("P1")) {
    return `Couldn't connect to the database as jack_readonly${e.errorCode ? ` (${e.errorCode})` : ""}. Tell the officers JACK_DATABASE_URL needs checking; the typed tools still work.`
  }
  if (e.code === "P2028") {
    return "The query took too long and its transaction was closed. Narrow it: filter, aggregate, or join less."
  }
  if (pgCode === "42501") {
    return `Permission denied: ${text}. That table or schema is off-limits to Jack (SystemSetting holds secrets; Supabase's auth, storage and realtime schemas aren't club data). Use the public tables from describe_schema.`
  }
  if (pgCode === "57014") {
    return `The query ran longer than ${STATEMENT_TIMEOUT} and was cancelled. Narrow it: filter, aggregate, or join less.`
  }
  if (pgCode === "25006") {
    return `${text}. SQL here is read-only; draft_event is the only way Jack creates anything.`
  }
  if (/cannot insert multiple commands/i.test(text)) {
    return "Only one statement per query. Send each SELECT in its own run_sql call."
  }
  const unsupported = /Failed to deserialize column of type '([^']+)'/.exec(text)
  if (unsupported) {
    return `A column has the Postgres type ${unsupported[1]}, which can't be returned as is. Cast it to text (column::text) or a number and try again.`
  }
  if (pgCode && pgCode !== "N/A") return `Postgres error ${pgCode}: ${text}`
  return `The query failed: ${text}`
}

function rowsLabel(count: number, truncated: boolean) {
  if (truncated) return `${MAX_SQL_ROWS}+ rows`
  if (count === 0) return "no rows"
  return count === 1 ? "1 row" : `${count} rows`
}

/** Turns the raw rows into the model's compact JSON and the room's displays */
export function shapeSqlResult(sql: string, raw: Record<string, unknown>[], ms: number, purpose?: string): JackToolResult {
  const truncated = raw.length > MAX_SQL_ROWS
  const grid = toGrid(raw.slice(0, MAX_SQL_ROWS))
  const rowCount = grid.rows.length

  const notes: string[] = []
  if (truncated) notes.push(`More than ${MAX_SQL_ROWS} rows matched; only the first ${MAX_SQL_ROWS} came back. Aggregate, or ORDER BY and LIMIT.`)
  const { text, kept } = fitRows(
    grid.rows,
    (rows) => ({
      columns: grid.columns,
      rowCount,
      truncated,
      ...(rows.length < rowCount
        ? { rowsIncluded: rows.length, note: [...notes, `Only the first ${rows.length} rows fit in this reply. Select fewer columns or aggregate.`].join(" ") }
        : notes.length
          ? { note: notes.join(" ") }
          : {}),
      rows,
    }),
    MAX_SQL_MODEL_CHARS,
  )

  const displays: JackToolDisplay[] = [{ kind: "sql", sql, rowCount, ms, truncated }]
  if (rowCount === 0) {
    displays.push({ kind: "note", text: "No rows." })
  } else {
    const shown = grid.rows.slice(0, SQL_TABLE_DISPLAY_ROWS).map((row) => row.map((cell) => (typeof cell === "string" ? (toCell(cell, DISPLAY_CELL_CHARS) as string) : cell)))
    const caption =
      shown.length < rowCount ? `First ${shown.length} of ${rowCount}${truncated ? "+" : ""} rows` : truncated ? `First ${rowCount} rows (more matched)` : rowsLabel(rowCount, false)
    displays.push({ kind: "table", columns: grid.columns, rows: shown, truncated: truncated || shown.length < rowCount, caption })
  }

  return {
    forModel: text,
    label: `${purpose?.trim() || "Ran a query"} (${rowsLabel(rowCount, truncated)}${kept < rowCount ? `, ${kept} sent to Jack` : ""})`,
    displays,
  }
}

const input = z.object({
  sql: z
    .string()
    .min(1)
    .max(10_000)
    .describe(
      'One PostgreSQL SELECT (or WITH … SELECT). Quote table and column names: "Event"."startsAtUtc". Give every output column a unique name.',
    ),
  purpose: z.string().max(80).optional().describe("A few words for the room on what this looks up, e.g. \"Paid LSC entries by week\""),
})

export const runSqlTool: JackTool<z.infer<typeof input>> = {
  name: "run_sql",
  description: [
    "Run one read-only SQL query (PostgreSQL) on the club database and get the rows back as JSON.",
    "Use it for questions the typed tools don't answer, or to dig deeper. Call describe_schema first if you haven't seen the tables.",
    'Rules: a single SELECT or WITH … SELECT; tables and columns are case-sensitive and must be double-quoted ("User"."displayName").',
    "Times are stored in UTC (timestamp without time zone). To show or group by Central time use (col AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago').",
    `At most ${MAX_SQL_ROWS} rows come back, and long results are trimmed: aggregate (COUNT, SUM, GROUP BY) rather than listing when you can.`,
    `Queries stop after ${STATEMENT_TIMEOUT}. Duplicate column names collapse, so alias them. Cast unusual types (interval, regclass, point) to text.`,
    "Money is stored in cents (amountCents): divide by 100 for dollars. The room sees the SQL and a table of the rows.",
  ].join(" "),
  input,
  async run({ sql, purpose }, ctx) {
    const prepared = prepareSql(sql)
    if (!prepared.ok) return { isError: true, forModel: prepared.error, label: "Query not run", displays: [] }

    const client = getJackSqlClient()
    if (!client) return { isError: true, forModel: JACK_SQL_MISSING, label: "Query not run (no database connection)", displays: [] }
    if (ctx.signal?.aborted) return { isError: true, forModel: "Cancelled before the query ran.", label: "Query cancelled", displays: [] }

    const started = performance.now()
    try {
      const rows = await client.$transaction(
        async (tx) => {
          // A pooled connection keeps any session settings a previous query changed with
          // set_config, so every query gets its own read-only transaction and timeout
          await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY")
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`)
          return tx.$queryRawUnsafe<Record<string, unknown>[]>(wrapSql(prepared.sql))
        },
        { maxWait: 5_000, timeout: 9_000 },
      )
      return shapeSqlResult(prepared.sql, rows, Math.round(performance.now() - started), purpose)
    } catch (error) {
      const ms = Math.round(performance.now() - started)
      return {
        isError: true,
        forModel: describeSqlError(error),
        label: `${purpose?.trim() || "Query"} failed`,
        displays: [{ kind: "sql", sql: prepared.sql, rowCount: 0, ms, truncated: false }],
      }
    }
  },
}
