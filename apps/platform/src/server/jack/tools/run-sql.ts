import { formatInTimeZone } from "date-fns-tz"
import { z } from "zod"
import type { JackToolDisplay } from "@/lib/jack/parts"
import { getJackSqlClient, JACK_SQL_MISSING } from "@/server/jack/sql-client"
import { fitRows, toCell, toGrid } from "./cells"
import { ct } from "./time"
import type { JackTool, JackToolResult } from "./types"

/**
 * run_sql: Jack writes his own SELECT (#161). It runs as `jack_readonly`, whose grants are the real
 * guard (read-only, public tables only, no SystemSetting). The checks here catch obvious mistakes
 * early, keep the result small, and turn away the catalog and settings reads every Postgres role is
 * allowed by default (see OFF_LIMITS_NAMES).
 */

export const MAX_SQL_ROWS = 200
export const MAX_SQL_MODEL_CHARS = 20_000
/** The room shows every row that came back (a member roster is about 110) */
export const SQL_TABLE_DISPLAY_ROWS = MAX_SQL_ROWS
const DISPLAY_CELL_CHARS = 200
const STATEMENT_TIMEOUT = "5s"
const UNLOCK_ALL = "SELECT pg_advisory_unlock_all()"

/**
 * Leading whitespace, comments and opening parentheses, which can come before the first keyword. A
 * -- comment ends at a newline or a carriage return, as Postgres reads it
 */
const LEAD = /^(?:\s|--[^\n\r]*(?:[\n\r]|$)|\/\*[\s\S]*?\*\/|\()*/

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
  const offLimits = findOffLimits(sql)
  if (offLimits) {
    return {
      ok: false,
      error: `Catalog and settings access is off-limits to Jack: ${offLimits} isn't allowed in run_sql (system catalogs and pg_ functions, server settings, XML exports, large objects and other databases). Query the club's tables in schema public instead; describe_schema lists them.`,
    }
  }
  return { ok: true, sql }
}

/**
 * What run_sql refuses, by name. jack_readonly's grants are the real guard (read-only, public tables,
 * no SystemSetting), but Postgres lets every role read the system catalogs and call many server
 * functions, grants or not, and a database can keep secrets there (local Supabase keeps its JWT
 * secret in a database setting, readable through current_setting and pg_db_role_setting). So, as
 * defense in depth, run_sql turns away:
 *
 * - every name starting with pg_ (the catalog tables and views, pg_catalog itself, and the server's
 *   pg_ functions: settings, function source, trigger arguments, files, locks, notifications, other
 *   sessions), except the harmless helpers in ALLOWED_PG_NAMES;
 * - the XML export functions (*_to_xml*, *xmlschema*), which read a table, a schema, a whole
 *   database or a query named in a string, where the name check can't see it;
 * - the names below: settings functions, catalog columns that hold settings or source, ts_stat
 *   (also runs a query from a string), large-object functions, and dblink (other databases).
 *
 * Names count as identifiers only: in a string or a comment they're fine, and an alias like
 * "notify" or "lo_count" is fine too.
 */
export const ALLOWED_PG_NAMES = new Set(["pg_typeof", "pg_size_pretty"])

export const OFF_LIMITS_NAMES = new Set([
  // settings, and catalog columns that hold settings or function source
  "current_setting",
  "set_config",
  "rolconfig",
  "useconfig",
  "setconfig",
  "prosrc",
  "probin",
  // runs a query given as text
  "ts_stat",
  // large objects (server files and stored blobs)
  "lo_import",
  "lo_export",
  "lo_get",
  "lo_put",
  "lo_open",
  "lo_close",
  "lo_creat",
  "lo_create",
  "lo_unlink",
  "lo_from_bytea",
  "lo_lseek",
  "lo_lseek64",
  "lo_tell",
  "lo_tell64",
  "lo_truncate",
  "lo_truncate64",
  "loread",
  "lowrite",
  "lo_manage",
])

/** Whether run_sql refuses an identifier (lowercased) */
export function isOffLimitsName(name: string): boolean {
  if (name.startsWith("pg_")) return !ALLOWED_PG_NAMES.has(name)
  if (name.includes("_to_xml") || name.includes("xmlschema")) return true
  return OFF_LIMITS_NAMES.has(name) || name.startsWith("dblink")
}

const IDENT_START = /[A-Za-z_\u0080-\uffff]/
const IDENT_PART = /[A-Za-z0-9_$\u0080-\uffff]/

/**
 * The identifiers in a query, lowercased, outside string literals and comments. Quoted identifiers
 * count by their name ("pg_settings" is pg_settings). Null when the query uses a Unicode-escaped
 * identifier (U&"…"), which can spell any name, so it's refused rather than decoded.
 */
export function sqlIdentifiers(sql: string): string[] | null {
  const names: string[] = []
  const n = sql.length
  const atWordStart = (i: number) => i === 0 || !IDENT_PART.test(sql[i - 1])
  /** Index just past a quoted string starting at `quote`. Backslash escapes only in E'…' strings */
  const skipString = (quote: number, backslashes: boolean) => {
    let j = quote + 1
    while (j < n) {
      if (backslashes && sql[j] === "\\") j += 2
      else if (sql[j] === "'") {
        if (sql[j + 1] === "'") j += 2
        else return j + 1
      } else j++
    }
    return n
  }

  let i = 0
  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === "-" && next === "-") {
      // A line comment ends at a newline or a carriage return (Postgres reads both)
      let end = i + 2
      while (end < n && sql[end] !== "\n" && sql[end] !== "\r") end++
      i = end + 1
    } else if (ch === "/" && next === "*") {
      // Block comments nest in Postgres
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++
          i += 2
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--
          i += 2
        } else i++
      }
    } else if ((ch === "U" || ch === "u") && next === "&" && sql[i + 2] === '"' && atWordStart(i)) {
      return null
    } else if (ch === "'") {
      i = skipString(i, false)
    } else if (/[EeBbXxNn]/.test(ch) && next === "'" && atWordStart(i)) {
      i = skipString(i + 1, ch === "E" || ch === "e")
    } else if (ch === "$" && atWordStart(i)) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length)
        i = close === -1 ? n : close + tag[0].length
      } else i++
    } else if (ch === '"') {
      let j = i + 1
      let name = ""
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] !== '"') break
          name += '"'
          j += 2
        } else name += sql[j++]
      }
      names.push(name.toLowerCase())
      i = j + 1
    } else if (IDENT_START.test(ch)) {
      let j = i + 1
      while (j < n && IDENT_PART.test(sql[j])) j++
      names.push(sql.slice(i, j).toLowerCase())
      i = j
    } else i++
  }
  return names
}

/** The first off-limits name a query uses (lowercased), or null when it uses none */
export function findOffLimits(sql: string): string | null {
  const names = sqlIdentifiers(sql)
  if (names === null) return 'a Unicode-escaped identifier (U&"…")'
  return names.find(isOffLimitsName) ?? null
}

/**
 * The extra column wrapSql adds: each row as Postgres writes it in JSON. Prisma returns date, time,
 * timestamp and timestamptz columns all as Dates (a time as one on 1970-01-01); the JSON tells them
 * apart ("2026-10-09", "10:00:00", "2026-10-09T21:49:00", "2026-10-09T21:49:00+00:00")
 */
export const ROW_JSON = "__jack_row"

/**
 * Caps the rows in the database (one more than the cap, to tell whether more matched) and adds
 * ROW_JSON. OFFSET 0 keeps Postgres from merging the query into the wrapper, which would work out each
 * row's expressions twice (once more for ROW_JSON); the inner alias keeps a column named jack_q from
 * clashing. The newline keeps a trailing -- comment from swallowing the wrapper.
 */
export function wrapSql(sql: string): string {
  return `SELECT jack_q.*, row_to_json(jack_q.*)::text AS "${ROW_JSON}" FROM (SELECT * FROM (\n${sql}\n) AS jack_inner OFFSET 0) AS jack_q LIMIT ${MAX_SQL_ROWS + 1}`
}

export type TimeKind = "date" | "time" | "timestamp" | "timestamptz"

/** Each row as Postgres wrote it in ROW_JSON (an empty object when it isn't there) */
export function writtenRows(raw: Record<string, unknown>[]): Record<string, unknown>[] {
  return raw.map((row) => {
    const json = row[ROW_JSON]
    if (typeof json !== "string") return {}
    try {
      return JSON.parse(json) as Record<string, unknown>
    } catch {
      return {}
    }
  })
}

/** What each Date column really is, from how Postgres wrote it (the first row where it isn't null) */
export function timeKinds(raw: Record<string, unknown>[], written = writtenRows(raw)): Map<string, TimeKind> {
  const kinds = new Map<string, TimeKind>()
  raw.forEach((row, i) => {
    for (const [column, value] of Object.entries(row)) {
      if (!(value instanceof Date) || kinds.has(column)) continue
      const text = written[i]?.[column]
      if (typeof text !== "string") continue
      kinds.set(
        column,
        /^\d{4}-\d{2}-\d{2}$/.test(text)
          ? "date"
          : /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}(:?\d{2})?)?$/.test(text)
            ? "time"
            : /(Z|[+-]\d{2}(:?\d{2})?)$/.test(text)
              ? "timestamptz"
              : "timestamp",
      )
    }
  })
  return kinds
}

/** "Fri 2026-10-09" for a calendar date */
function dateWithWeekday(date: string): string {
  return formatInTimeZone(new Date(`${date}T12:00:00Z`), "UTC", "EEE yyyy-MM-dd")
}

const CENTRAL_ZONE = String.raw`(?:America\/Chicago|US\/Central|CST6CDT|CST|CDT)`

/**
 * SQL that converts a time to Central and leaves it a timestamp, which run_sql then can't tell from
 * stored UTC. A conversion cast to date or text, compared in a filter, or formatted by to_char (a
 * format string comes next) comes out as something else, so it doesn't count. timezone('America/Chicago', x)
 * is the same conversion as a function
 */
const CONVERTS_TO_CENTRAL = new RegExp(
  String.raw`AT\s+TIME\s+ZONE\s+'${CENTRAL_ZONE}'(?!\s*\)*\s*(?:::\s*(?:date|text)|,\s*'|[<>=!]|BETWEEN\b|IN\b))|\btimezone\s*\(\s*'${CENTRAL_ZONE}'`,
  "i",
)

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
  const written = writtenRows(raw.slice(0, MAX_SQL_ROWS))
  const kinds = timeKinds(raw.slice(0, MAX_SQL_ROWS), written)
  const rows = raw.slice(0, MAX_SQL_ROWS).map((row) => {
    const copy = { ...row }
    delete copy[ROW_JSON]
    return copy
  })
  const grid = toGrid(rows)
  const rowCount = grid.rows.length

  // Times: the model gets each in Central time with its weekday, dates with their weekday, and a time
  // of day as written; the room's table keeps UTC ISO for times (it shows those in Central itself),
  // plain dates, and times of day as written
  const dateColumns = new Set(grid.columns.filter((column) => rows.some((row) => row[column] instanceof Date)))
  const kindOf = (column: string): TimeKind | null => (dateColumns.has(column) ? (kinds.get(column) ?? "timestamp") : null)
  const columnKinds = grid.columns.map(kindOf)
  const asWritten = (r: number, column: string, cell: unknown) => (typeof written[r]?.[column] === "string" ? (written[r][column] as string) : cell)
  const forDisplay = (cell: unknown, kind: TimeKind | null, r: number, column: string) =>
    typeof cell !== "string" ? cell : kind === "date" ? cell.slice(0, 10) : kind === "time" ? asWritten(r, column, cell) : cell
  const forModelCell = (cell: unknown, kind: TimeKind | null, r: number, column: string) => {
    if (!kind || typeof cell !== "string") return cell
    if (kind === "date") return dateWithWeekday(cell.slice(0, 10))
    if (kind === "time") return asWritten(r, column, cell)
    return ct(new Date(cell))
  }
  const modelRows = grid.rows.map((row, r) => row.map((cell, i) => forModelCell(cell, columnKinds[i], r, grid.columns[i])))
  const displayRows = grid.rows.map((row, r) => row.map((cell, i) => forDisplay(cell, columnKinds[i], r, grid.columns[i])))

  const notes: string[] = []
  if (truncated) notes.push(`More than ${MAX_SQL_ROWS} rows matched; only the first ${MAX_SQL_ROWS} came back. Aggregate, or ORDER BY and LIMIT.`)
  if (columnKinds.some((k) => k === "timestamp" || k === "timestamptz")) {
    notes.push(
      CONVERTS_TO_CENTRAL.test(sql)
        ? "Times are shown in Central time, read as stored (UTC). This query converts times with AT TIME ZONE: a column already converted to Central shows shifted here. Select times as stored, or cast a converted bucket to date (date_trunc(...)::date)."
        : "Times are shown in Central time (CT) with the weekday."
    )
  }
  const { text, kept } = fitRows(
    modelRows,
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
    const shown = displayRows.slice(0, SQL_TABLE_DISPLAY_ROWS).map((row) => row.map((cell) => (typeof cell === "string" ? (toCell(cell, DISPLAY_CELL_CHARS) as string) : cell)) as typeof grid.rows[number])
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
    "Times are stored in UTC. run_sql shows each column that is a time in Central time with the weekday (and dates with their weekday), so select times as their own columns, as stored, and don't convert them in SELECT. Times inside text, JSON or arrays come back as stored (UTC). To group or filter by Central day, week or month, convert inside the expression and cast the bucket to date: date_trunc('week', col AT TIME ZONE 'UTC' AT TIME ZONE 'America/Chicago')::date.",
    `At most ${MAX_SQL_ROWS} rows come back, and long results are trimmed: aggregate (COUNT, SUM, GROUP BY) rather than listing when you can.`,
    `Queries stop after ${STATEMENT_TIMEOUT}. Duplicate column names collapse, so alias them. Cast unusual types (interval, regclass, point) to text.`,
    "Money is stored in cents (amountCents): divide by 100 for dollars. The room sees the SQL and a table of the rows.",
    "The system catalogs and pg_ functions (except pg_typeof and pg_size_pretty), server settings, XML exports and large objects are off-limits.",
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
          // Session advisory locks outlive the transaction on a pooled connection. prepareSql refuses
          // pg_ functions, so there shouldn't be any; this lets go of any that got through anyway,
          // also when the query fails (the savepoint keeps the transaction usable for it)
          await tx.$executeRawUnsafe("SAVEPOINT jack_query")
          let rows: Record<string, unknown>[]
          try {
            rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(wrapSql(prepared.sql))
          } catch (error) {
            await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT jack_query")
            await tx.$executeRawUnsafe(UNLOCK_ALL)
            throw error
          }
          await tx.$executeRawUnsafe(UNLOCK_ALL)
          return rows
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
