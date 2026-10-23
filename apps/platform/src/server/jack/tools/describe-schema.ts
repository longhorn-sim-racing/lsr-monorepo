import { z } from "zod"
import { getJackSqlClient, JACK_SQL_MISSING } from "@/server/jack/sql-client"
import { describeSqlError } from "./run-sql"
import { JACK_SCHEMA_NOTES, TABLE_NOTES } from "./schema-notes"
import { mergeTableNotes, SLOT_SCHEMA_NOTES, SLOT_TABLE_NOTES } from "./schema-notes/registry"
import type { JackTool } from "./types"

/**
 * describe_schema: the tables Jack can read, with their columns, keys and enums (#161). Read as
 * jack_readonly, so it lists exactly what run_sql can see: information_schema only shows tables the
 * role has a privilege on (SystemSetting and _prisma_migrations drop out by themselves).
 */

export type SchemaColumn = { t: string; c: string; dt: string; udt: string; nullable: boolean }
export type SchemaConstraint = { t: string; kind: string; def: string }
export type SchemaEnum = { name: string; labels: string }

const COLUMNS_SQL = `
  SELECT c.table_name::text AS t, c.column_name::text AS c, c.data_type::text AS dt, c.udt_name::text AS udt,
         (c.is_nullable = 'YES') AS nullable
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
  ORDER BY c.table_name, c.ordinal_position`

const CONSTRAINTS_SQL = `
  SELECT cl.relname::text AS t, con.contype::text AS kind, pg_get_constraintdef(con.oid) AS def
  FROM pg_constraint con
  JOIN pg_class cl ON cl.oid = con.conrelid
  WHERE con.connamespace = 'public'::regnamespace AND con.contype IN ('p', 'f') AND has_table_privilege(cl.oid, 'SELECT')`

const ENUMS_SQL = `
  SELECT t.typname::text AS name, string_agg(e.enumlabel::text, '|' ORDER BY e.enumsortorder) AS labels
  FROM pg_type t
  JOIN pg_enum e ON e.enumtypid = t.oid
  WHERE t.typnamespace = 'public'::regnamespace
  GROUP BY t.typname
  ORDER BY t.typname`

const TYPE_NAMES: Record<string, string> = {
  "timestamp without time zone": "timestamp",
  "timestamp with time zone": "timestamptz",
  "character varying": "varchar",
  "double precision": "float8",
  integer: "int",
  boolean: "bool",
}

export function typeName(column: Pick<SchemaColumn, "dt" | "udt">): string {
  if (column.dt === "USER-DEFINED") return column.udt
  if (column.dt === "ARRAY") return `${column.udt.replace(/^_/, "")}[]`
  return TYPE_NAMES[column.dt] ?? column.dt
}

const unquote = (name: string) => name.trim().replace(/^"|"$/g, "")

/** The core table notes with the Jack 2.0 tracks' notes appended (schema-notes/<track>.ts) */
const ALL_TABLE_NOTES = mergeTableNotes(TABLE_NOTES, SLOT_TABLE_NOTES)

/** Columns that are the primary key, and where each foreign key points, from pg_get_constraintdef */
export function parseConstraints(rows: SchemaConstraint[]) {
  const primary = new Map<string, Set<string>>()
  const foreign = new Map<string, Map<string, string>>()
  for (const row of rows) {
    if (row.kind === "p") {
      const cols = /PRIMARY KEY \(([^)]*)\)/.exec(row.def)?.[1].split(",").map(unquote) ?? []
      primary.set(row.t, new Set(cols))
    } else if (row.kind === "f") {
      const match = /FOREIGN KEY \(([^)]*)\) REFERENCES ((?:"[^"]+"|[\w.]+))\(([^)]*)\)/.exec(row.def)
      if (!match) continue
      const cols = match[1].split(",").map(unquote)
      const target = unquote(match[2].replace(/^public\./, ""))
      const map = foreign.get(row.t) ?? new Map<string, string>()
      if (cols.length === 1) map.set(cols[0], target)
      foreign.set(row.t, map)
    }
  }
  return { primary, foreign }
}

/**
 * The text the model reads: one block per table, then the enums, then (for the full schema) the notes:
 * the core notes, then each track's. `tableNotes` and `trackNotes` default to the real ones (tests pass their own)
 */
export function formatSchema(
  columns: SchemaColumn[],
  constraints: SchemaConstraint[],
  enums: SchemaEnum[],
  options: { tables?: string[]; tableNotes?: Record<string, string>; trackNotes?: string[] } = {},
): { text: string; tables: string[]; missing: string[] } {
  const { tableNotes = ALL_TABLE_NOTES, trackNotes = SLOT_SCHEMA_NOTES } = options
  const { primary, foreign } = parseConstraints(constraints)
  const byTable = new Map<string, SchemaColumn[]>()
  for (const column of columns) byTable.set(column.t, [...(byTable.get(column.t) ?? []), column])

  const wanted = options.tables?.map((t) => unquote(t).toLowerCase())
  const names = [...byTable.keys()].filter((t) => !wanted || wanted.includes(t.toLowerCase()))
  const missing = (options.tables ?? []).filter((t) => !names.some((n) => n.toLowerCase() === unquote(t).toLowerCase()))

  const usedEnums = new Set<string>()
  const blocks = names.map((table) => {
    const cols = (byTable.get(table) ?? []).map((column) => {
      const type = typeName(column)
      const base = type.replace(/\[\]$/, "")
      if (enums.some((e) => e.name === base)) usedEnums.add(base)
      const pk = primary.get(table)?.has(column.c) ? " pk" : ""
      const fk = foreign.get(table)?.get(column.c)
      return `${column.c} ${type}${column.nullable ? "?" : ""}${pk}${fk ? ` -> ${fk}` : ""}`
    })
    const note = tableNotes[table]
    return `"${table}"${note ? ` (${note})` : ""}\n  ${cols.join(", ")}`
  })

  const enumLines = enums.filter((e) => usedEnums.has(e.name)).map((e) => `${e.name}: ${e.labels}`)
  const parts = [
    wanted
      ? `Tables (${names.length}). "?" = nullable, pk = primary key, -> = foreign key to that table's id.`
      : `Tables Jack can read (${names.length}). "?" = nullable, pk = primary key, -> = foreign key to that table's id. Times are UTC; money is cents.`,
    blocks.join("\n"),
  ]
  if (enumLines.length) parts.push(`Enums\n${enumLines.join("\n")}`)
  if (missing.length) parts.push(`Not found, or not readable by Jack: ${missing.join(", ")}`)
  if (!wanted) parts.push(JACK_SCHEMA_NOTES, ...trackNotes)
  return { text: parts.join("\n\n"), tables: names, missing }
}

const input = z.object({
  tables: z
    .array(z.string().max(64))
    .max(20)
    .optional()
    .describe('Only these tables, e.g. ["Event", "EventRegistration"]. Leave out for every table plus the notes on what they mean.'),
})

export const describeSchemaTool: JackTool<z.infer<typeof input>> = {
  name: "describe_schema",
  description:
    "List the database tables Jack can read, with their columns, types, keys and enum values, plus notes on what the tricky ones mean (what counts as paid for LSC, event status, registrations vs attendance, membership tiers, results). Call it before writing SQL for run_sql, once per conversation; pass tables to look at a few again.",
  input,
  async run({ tables }) {
    const client = getJackSqlClient()
    if (!client) return { isError: true, forModel: JACK_SQL_MISSING, label: "Couldn't read the schema", displays: [] }
    try {
      const [columns, constraints, enums] = await client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY")
        return Promise.all([
          tx.$queryRawUnsafe<SchemaColumn[]>(COLUMNS_SQL),
          tx.$queryRawUnsafe<SchemaConstraint[]>(CONSTRAINTS_SQL),
          tx.$queryRawUnsafe<SchemaEnum[]>(ENUMS_SQL),
        ])
      })
      const result = formatSchema(columns, constraints, enums, { tables })
      const label = tables?.length
        ? `Looked at ${result.tables.length === 1 ? `the ${result.tables[0]} table` : `${result.tables.length} tables`}`
        : `Looked at the schema (${result.tables.length} tables)`
      return { forModel: result.text, label, displays: [] }
    } catch (error) {
      return { isError: true, forModel: describeSqlError(error), label: "Couldn't read the schema", displays: [] }
    }
  },
}
