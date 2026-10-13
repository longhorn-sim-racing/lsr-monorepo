import { beforeEach, describe, expect, it, vi } from "vitest"

// A stand-in for the jack_readonly client: records what the tool sends inside its transaction
const sql = vi.hoisted(() => ({ client: null as unknown, executed: [] as string[], query: vi.fn() }))
vi.mock("@/server/jack/sql-client", () => ({
  getJackSqlClient: () => sql.client,
  JACK_SQL_MISSING: "JACK_DATABASE_URL is missing",
}))

import { fitRows, toCell, toGrid } from "./cells"
import {
  describeSqlError,
  findOffLimits,
  MAX_SQL_MODEL_CHARS,
  MAX_SQL_ROWS,
  prepareSql,
  runSqlTool,
  shapeSqlResult,
  SQL_TABLE_DISPLAY_ROWS,
  sqlIdentifiers,
  wrapSql,
} from "./run-sql"

const ctx = { roomId: "room-1", actor: { userId: "u1", displayName: "Alex" } }

function fakeClient() {
  const tx = {
    $executeRawUnsafe: vi.fn(async (text: string) => {
      sql.executed.push(text)
      return 0
    }),
    $queryRawUnsafe: vi.fn(async (text: string) => {
      sql.executed.push(text)
      return sql.query(text)
    }),
  }
  return { $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) }
}

const pgError = (code: string, message: string) => Object.assign(new Error("Raw query failed"), { code: "P2010", meta: { code, message: `ERROR: ${message}` } })

beforeEach(() => {
  sql.executed = []
  sql.client = fakeClient()
})

describe("prepareSql", () => {
  it("strips trailing semicolons and whitespace", () => {
    expect(prepareSql("  select 1 ;; \n")).toEqual({ ok: true, sql: "select 1" })
  })

  it("accepts WITH, leading comments and parentheses", () => {
    expect(prepareSql("WITH x AS (SELECT 1) SELECT * FROM x").ok).toBe(true)
    expect(prepareSql("-- members\n/* note */ SELECT 1").ok).toBe(true)
    expect(prepareSql("(SELECT 1) UNION (SELECT 2)").ok).toBe(true)
  })

  it("rejects anything that isn't a SELECT or WITH", () => {
    for (const text of ['DELETE FROM "Tag"', "update x set y = 1", "insert into x values (1)", "DROP TABLE x", "SET ROLE postgres", "selectx 1", "-- just a comment"]) {
      const result = prepareSql(text)
      expect(result.ok, text).toBe(false)
    }
    expect(prepareSql(" ; ")).toEqual({ ok: false, error: expect.stringContaining("empty") })
  })

  it("turns away catalog, settings and server-function access, whatever the case or quoting", () => {
    const blocked: [string, string][] = [
      ["SELECT current_setting('app.settings.jwt_secret')", "current_setting"],
      ["SELECT pg_catalog.CURRENT_SETTING('app.settings.jwt_secret', true)", "current_setting"],
      ["SELECT set_config('statement_timeout', '0', false)", "set_config"],
      ["SELECT name, setting FROM pg_settings", "pg_settings"],
      ['SELECT * FROM pg_catalog."pg_settings"', "pg_settings"],
      ["SELECT * FROM pg_show_all_settings()", "pg_show_all_settings"],
      ["SELECT setconfig FROM pg_db_role_setting", "setconfig"],
      ["SELECT * FROM pg_file_settings", "pg_file_settings"],
      ["SELECT rolname, rolconfig FROM pg_roles", "rolconfig"],
      ["SELECT tgargs FROM pg_trigger", "pg_trigger"],
      ["SELECT pg_get_triggerdef(oid) FROM pg_trigger", "pg_get_triggerdef"],
      ["SELECT prosrc FROM pg_proc", "prosrc"],
      ["SELECT pg_get_functiondef('jack_private.is_officer'::regproc)", "pg_get_functiondef"],
      ["SELECT pg_advisory_lock(1)", "pg_advisory_lock"],
      ["SELECT pg_advisory_xact_lock(1)", "pg_advisory_xact_lock"],
      ["SELECT pg_try_advisory_lock(1)", "pg_try_advisory_lock"],
      ["SELECT pg_notify('room', 'hi')", "pg_notify"],
      ["SELECT pg_read_file('postgresql.conf')", "pg_read_file"],
      ["SELECT pg_read_binary_file('postgresql.conf')", "pg_read_binary_file"],
      ["SELECT * FROM pg_ls_dir('.')", "pg_ls_dir"],
      ["SELECT pg_stat_file('postgresql.conf')", "pg_stat_file"],
      ["SELECT lo_import('/etc/passwd')", "lo_import"],
      ["SELECT * FROM dblink('host=x', 'select 1') AS t(a int)", "dblink"],
      ["SELECT pg_terminate_backend(1)", "pg_terminate_backend"],
      ["SELECT pg_cancel_backend(1)", "pg_cancel_backend"],
      ["SELECT query_to_xml('select current_setting(''x'')', true, true, '')", "query_to_xml"],
      ['WITH s AS (SELECT "current_setting"(\'x\') AS v) SELECT v FROM s', "current_setting"],
      ['SELECT U&"\\0063urrent_setting"(\'x\')', 'a Unicode-escaped identifier (U&"…")'],
    ]
    for (const [sql, name] of blocked) {
      const result = prepareSql(sql)
      expect(result.ok, sql).toBe(false)
      if (!result.ok) {
        expect(result.error, sql).toContain("off-limits")
        expect(result.error, sql).toContain(name)
      }
    }
  })

  it("doesn't mistake strings, comments, aliases or the club's own names for off-limits ones", () => {
    const fine = [
      "SELECT 'current_setting' AS s",
      "SELECT 1 -- pg_settings\n",
      "SELECT 1 /* pg_proc /* nested */ prosrc */",
      "SELECT E'it\\'s pg_settings' AS s",
      "SELECT $$pg_read_file('x')$$ AS s",
      "SELECT $q$ lo_import $q$ AS s",
      'SELECT count(*) AS listens FROM "Notification" n JOIN "NotificationPreference" p ON p."userId" = n."userId"',
      'SELECT "User"."displayName" AS "pg_note" FROM "User"',
    ]
    for (const sql of fine) expect(prepareSql(sql).ok, sql).toBe(true)
    expect(findOffLimits('SELECT "Event"."title" FROM "Event"')).toBeNull()
    expect(sqlIdentifiers('SELECT "a""b" FROM x')).toEqual(["select", 'a"b', "from", "x"])
  })
})

describe("wrapSql", () => {
  it("caps rows at one past the limit and keeps a trailing comment from eating the wrapper", () => {
    const wrapped = wrapSql("SELECT 1 -- note")
    expect(wrapped).toBe(`SELECT * FROM (\nSELECT 1 -- note\n) AS jack_q LIMIT ${MAX_SQL_ROWS + 1}`)
  })
})

describe("toCell", () => {
  it("serializes BigInt, Decimal, Date, bytes and JSON safely", () => {
    expect(toCell(BigInt(12))).toBe(12)
    expect(toCell(BigInt("18446744073709551616"))).toBe("18446744073709551616")
    const decimal = (text: string) => ({ toFixed: () => text, toNumber: () => Number(text), toString: () => text })
    expect(toCell(decimal("10.5"))).toBe(10.5)
    expect(toCell(decimal("12345678901234567890.5"))).toBe("12345678901234567890.5")
    expect(toCell(new Date("2026-10-19T23:00:00.000Z"))).toBe("2026-10-19T23:00:00.000Z")
    expect(toCell(new Date("nope"))).toBeNull()
    expect(toCell(new Uint8Array([1, 2, 3]))).toBe("<3 bytes>")
    expect(toCell({ a: 1, big: BigInt(3) })).toBe('{"a":1,"big":"3"}')
    expect(toCell([1, 2])).toBe("[1,2]")
    expect(toCell(undefined)).toBeNull()
    expect(toCell(Number.NaN)).toBe("NaN")
    expect(toCell(true)).toBe(true)
  })

  it("cuts long text and says how much", () => {
    expect(toCell("x".repeat(30), 10)).toBe(`${"x".repeat(10)}… (+20 chars)`)
  })

  it("turns rows of objects into columns and cells", () => {
    expect(toGrid([{ a: BigInt(1), b: null }, { a: BigInt(2), b: "x" }])).toEqual({ columns: ["a", "b"], rows: [[1, null], [2, "x"]] })
    expect(toGrid([])).toEqual({ columns: [], rows: [] })
  })
})

describe("fitRows", () => {
  it("keeps every row when they fit, and as many as fit when they don't", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ["row".repeat(10), i])
    expect(fitRows(rows, (r) => ({ rows: r }), 100_000).kept).toBe(100)
    const { text, kept } = fitRows(rows, (r) => ({ rows: r }), 1_000)
    expect(kept).toBeGreaterThan(0)
    expect(kept).toBeLessThan(100)
    expect(text.length).toBeLessThanOrEqual(1_000)
    expect(JSON.parse(text).rows).toHaveLength(kept)
  })
})

describe("shapeSqlResult", () => {
  it("returns compact JSON plus an sql and a table display", () => {
    const result = shapeSqlResult('SELECT status FROM "Event"', [{ status: "DRAFT", n: BigInt(3) }], 12, "Events by status")
    expect(JSON.parse(result.forModel)).toEqual({ columns: ["status", "n"], rowCount: 1, truncated: false, rows: [["DRAFT", 3]] })
    expect(result.label).toBe("Events by status (1 row)")
    expect(result.displays).toEqual([
      { kind: "sql", sql: 'SELECT status FROM "Event"', rowCount: 1, ms: 12, truncated: false },
      { kind: "table", columns: ["status", "n"], rows: [["DRAFT", 3]], truncated: false, caption: "1 row" },
    ])
  })

  it("flags results past the row cap and shows only the first rows in the room", () => {
    const raw = Array.from({ length: MAX_SQL_ROWS + 1 }, (_, i) => ({ n: i }))
    const result = shapeSqlResult("SELECT n", raw, 5)
    const body = JSON.parse(result.forModel)
    expect(body.rowCount).toBe(MAX_SQL_ROWS)
    expect(body.truncated).toBe(true)
    expect(body.note).toContain(`More than ${MAX_SQL_ROWS} rows`)
    expect(result.label).toBe(`Ran a query (${MAX_SQL_ROWS}+ rows)`)
    const table = result.displays?.find((d) => d.kind === "table")
    expect(table).toMatchObject({ truncated: true, caption: `First ${SQL_TABLE_DISPLAY_ROWS} of ${MAX_SQL_ROWS}+ rows` })
    expect(table?.kind === "table" && table.rows).toHaveLength(SQL_TABLE_DISPLAY_ROWS)
  })

  it("trims rows to keep the model's text under the cap", () => {
    const raw = Array.from({ length: 150 }, () => ({ text: "y".repeat(900) }))
    const result = shapeSqlResult("SELECT text", raw, 5)
    expect(result.forModel.length).toBeLessThanOrEqual(MAX_SQL_MODEL_CHARS)
    const body = JSON.parse(result.forModel)
    expect(body.rowCount).toBe(150)
    expect(body.rowsIncluded).toBe(body.rows.length)
    expect(body.note).toContain("fit in this reply")
    expect(result.label).toMatch(/150 rows, \d+ sent to Jack/)
  })

  it("says so when nothing matched", () => {
    const result = shapeSqlResult("SELECT 1 WHERE false", [], 3)
    expect(JSON.parse(result.forModel)).toEqual({ columns: [], rowCount: 0, truncated: false, rows: [] })
    expect(result.displays?.[1]).toEqual({ kind: "note", text: "No rows." })
  })
})

describe("describeSqlError", () => {
  it("says a permission error means the table is off-limits", () => {
    const message = describeSqlError(pgError("42501", "permission denied for table SystemSetting"))
    expect(message).toMatch(/^Permission denied: permission denied for table SystemSetting\./)
    expect(message).toContain("off-limits")
  })

  it("maps timeouts, read-only, multiple statements and unsupported types", () => {
    expect(describeSqlError(pgError("57014", "canceling statement due to statement timeout"))).toContain("longer than 5s")
    expect(describeSqlError(pgError("25006", "cannot execute INSERT in a read-only transaction"))).toContain("read-only")
    expect(describeSqlError(pgError("42601", "cannot insert multiple commands into a prepared statement"))).toContain("Only one statement")
    expect(describeSqlError({ meta: { code: "N/A", message: "Failed to deserialize column of type 'interval'. If you're…" } })).toContain("Cast it to text")
    expect(describeSqlError({ code: "P2028", message: "Transaction already closed" })).toContain("took too long")
  })

  it("passes other Postgres errors through so the model can fix its query", () => {
    expect(describeSqlError(pgError("42703", 'column "nope" does not exist'))).toBe('Postgres error 42703: column "nope" does not exist')
  })

  it("reports a connection failure without the connection string", () => {
    const error = Object.assign(new Error("Authentication failed against database server at 127.0.0.1"), { name: "PrismaClientInitializationError", errorCode: "P1000" })
    const message = describeSqlError(error)
    expect(message).toContain("Couldn't connect")
    expect(message).toContain("P1000")
  })
})

describe("run_sql", () => {
  it("runs the query in a read-only transaction with a 5s timeout, wrapped with the row cap, then drops any advisory locks", async () => {
    sql.query.mockResolvedValue([{ n: BigInt(4) }])
    const result = await runSqlTool.run({ sql: 'SELECT count(*) AS n FROM "User";' }, ctx)
    expect(result.isError).toBeUndefined()
    expect(sql.executed).toEqual([
      "SET TRANSACTION READ ONLY",
      "SET LOCAL statement_timeout = '5s'",
      wrapSql('SELECT count(*) AS n FROM "User"'),
      "SELECT pg_advisory_unlock_all()",
    ])
    expect(JSON.parse(result.forModel).rows).toEqual([[4]])
  })

  it("refuses a settings read before it reaches the database", async () => {
    const result = await runSqlTool.run({ sql: "SELECT current_setting('app.settings.jwt_secret') AS s" }, ctx)
    expect(result).toMatchObject({ isError: true, label: "Query not run" })
    expect(result.forModel).toMatch(/^Catalog and settings access is off-limits/)
    expect(sql.executed).toEqual([])
  })

  it("rejects a write before it reaches the database", async () => {
    const result = await runSqlTool.run({ sql: 'DELETE FROM "Event"' }, ctx)
    expect(result.isError).toBe(true)
    expect(sql.executed).toEqual([])
  })

  it("returns Postgres's message as an error the model can act on, with the SQL for the room", async () => {
    sql.query.mockRejectedValue(pgError("42501", "permission denied for schema auth"))
    const result = await runSqlTool.run({ sql: "SELECT * FROM auth.users" }, ctx)
    expect(result.isError).toBe(true)
    expect(result.forModel).toContain("off-limits")
    expect(result.displays?.[0]).toMatchObject({ kind: "sql", sql: "SELECT * FROM auth.users", rowCount: 0 })
  })

  it("explains when JACK_DATABASE_URL isn't set", async () => {
    sql.client = null
    const result = await runSqlTool.run({ sql: "SELECT 1" }, ctx)
    expect(result).toMatchObject({ isError: true, forModel: "JACK_DATABASE_URL is missing" })
  })

  it("validates its input with the schema the model loop uses", () => {
    expect(runSqlTool.input.safeParse({ sql: "" }).success).toBe(false)
    expect(runSqlTool.input.safeParse({ sql: "SELECT 1", purpose: "x".repeat(81) }).success).toBe(false)
    expect(runSqlTool.input.safeParse({ sql: "SELECT 1" }).success).toBe(true)
  })
})
