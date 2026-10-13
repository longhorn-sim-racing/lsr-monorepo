import { describe, expect, it } from "vitest"
import { checkEvalDatabase, mentionsDollars, mentionsNumber, parseDatabaseUrl, stripDatesAndTimes } from "./eval-support"

const LOCAL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
const LOCAL_JACK = "postgresql://jack_readonly:pw@127.0.0.1:54322/postgres"
const POOLER = "postgresql://postgres.abcdefgh:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true"
const POOLER_JACK = "postgresql://jack_readonly.abcdefgh:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true"

describe("checkEvalDatabase", () => {
  it("runs against this machine when both URLs are the same database", () => {
    expect(checkEvalDatabase({ DATABASE_URL: LOCAL, JACK_DATABASE_URL: LOCAL_JACK })).toEqual({
      ok: true,
      host: "127.0.0.1",
      port: "54322",
      database: "postgres",
      local: true,
    })
    expect(checkEvalDatabase({ DATABASE_URL: LOCAL.replace("127.0.0.1", "localhost"), JACK_DATABASE_URL: LOCAL_JACK.replace("127.0.0.1", "localhost") }).ok).toBe(true)
  })

  it("refuses a remote database unless --allow-remote names its exact host", () => {
    const remote = checkEvalDatabase({ DATABASE_URL: POOLER, JACK_DATABASE_URL: POOLER_JACK })
    expect(remote.ok).toBe(false)
    expect(!remote.ok && remote.error).toContain("--allow-remote=aws-0-us-east-1.pooler.supabase.com")
    expect(!remote.ok && remote.error).not.toContain("secret")

    expect(checkEvalDatabase({ DATABASE_URL: POOLER, JACK_DATABASE_URL: POOLER_JACK }, "pooler.supabase.com").ok).toBe(false)
    expect(checkEvalDatabase({ DATABASE_URL: POOLER, JACK_DATABASE_URL: POOLER_JACK }, "")).toMatchObject({ ok: false })
    expect(checkEvalDatabase({ DATABASE_URL: POOLER, JACK_DATABASE_URL: POOLER_JACK }, "aws-0-us-east-1.pooler.supabase.com")).toMatchObject({
      ok: true,
      local: false,
      host: "aws-0-us-east-1.pooler.supabase.com",
    })
  })

  it("refuses when JACK_DATABASE_URL is missing or points somewhere else", () => {
    expect(checkEvalDatabase({ DATABASE_URL: LOCAL })).toMatchObject({ ok: false, error: expect.stringContaining("JACK_DATABASE_URL isn't set") })
    expect(checkEvalDatabase({ DATABASE_URL: LOCAL, JACK_DATABASE_URL: POOLER_JACK })).toMatchObject({ ok: false, error: expect.stringContaining("host aws-0") })
    expect(checkEvalDatabase({ DATABASE_URL: LOCAL, JACK_DATABASE_URL: LOCAL_JACK.replace("/postgres", "/other") })).toMatchObject({
      ok: false,
      error: expect.stringContaining("database other"),
    })
    // Same regional pooler and database name, different Supabase project
    const otherProject = POOLER_JACK.replace("jack_readonly.abcdefgh", "jack_readonly.zyxwvuts")
    expect(checkEvalDatabase({ DATABASE_URL: POOLER, JACK_DATABASE_URL: otherProject }, "aws-0-us-east-1.pooler.supabase.com")).toMatchObject({
      ok: false,
      error: expect.stringContaining("project zyxwvuts"),
    })
  })

  it("refuses when DATABASE_URL is missing or isn't Postgres", () => {
    expect(checkEvalDatabase({}).ok).toBe(false)
    expect(checkEvalDatabase({ DATABASE_URL: "mysql://127.0.0.1/x", JACK_DATABASE_URL: LOCAL_JACK }).ok).toBe(false)
    expect(parseDatabaseUrl("not a url")).toBeNull()
  })
})

describe("stripDatesAndTimes", () => {
  it("takes out dates, times and years, and leaves counts", () => {
    const text = stripDatesAndTimes("GM 1 is Mon, Oct 13, 7:00 PM CT (2026-10-13T19:00), 10/13/2026 or 13 October 2026; 9 PM; 13 may have paid; 26 applications")
    expect(text).not.toMatch(/\b(13|7|19|10|2026|9)\b(?! may| applications)/)
    expect(text).toContain("13 may have paid")
    expect(text).toContain("26 applications")
    expect(text).toContain("GM 1")
  })
})

describe("mentionsNumber", () => {
  it("finds a count written as digits, with a thousands comma, or as a word", () => {
    expect(mentionsNumber("There are 13 applications.", 13)).toBe(true)
    expect(mentionsNumber("1,234 accounts", 1234)).toBe(true)
    expect(mentionsNumber("Seven people checked in.", 7)).toBe(true)
    expect(mentionsNumber("There are 130 applications.", 13)).toBe(false)
    expect(mentionsNumber("It cost $13.50", 13)).toBe(false)
  })

  it("doesn't count dates, times or years (the false passes)", () => {
    const answer = "GM 1 is on the calendar: Mon, Oct 13, 7:00 PM to 9:00 PM CT, 2026."
    expect(mentionsNumber(answer, 13)).toBe(false)
    expect(mentionsNumber(answer, 7)).toBe(false)
    expect(mentionsNumber(answer, 9)).toBe(false)
    expect(mentionsNumber(answer, 2026)).toBe(false)
    expect(mentionsNumber("Last updated 10/13 at 7 pm.", 13)).toBe(false)
    expect(mentionsNumber("Last updated 10/13 at 7 pm.", 7)).toBe(false)
    expect(mentionsNumber("Drafted for 2026-10-16T19:00 CT", 19)).toBe(false)
    expect(mentionsNumber("Drafted for 2026-10-16T19:00 CT", 16)).toBe(false)
    expect(mentionsNumber("Checked in on 13 October", 13)).toBe(false)
    expect(mentionsNumber("Starts October 13th, 2026", 13)).toBe(false)
  })

  it("with nouns, wants the count next to its noun unless it's the only number", () => {
    const paid = ["paid", "driver", "entr", "fee"]
    expect(mentionsNumber("There are 26 applications, and 13 drivers have paid.", 13, paid)).toBe(true)
    expect(mentionsNumber("Paid entries: 13 (of 26 applications).", 13, paid)).toBe(true)
    expect(mentionsNumber("13 have paid so far.", 13, paid)).toBe(true)
    expect(mentionsNumber("13.", 13, paid)).toBe(true) // the only number, so it can't be anything else's
    // 13 is there, but as something else's count
    expect(mentionsNumber("There are 13 applications and 9 paid entries.", 13, paid)).toBe(false)
    expect(mentionsNumber("Round 13 had 9 paid entries.", 13, paid)).toBe(false)
  })

  it("with nouns, still ignores dates next to the noun", () => {
    expect(mentionsNumber("Applications as of Oct 13: 26.", 13, ["application"])).toBe(false)
    expect(mentionsNumber("Applications as of Oct 13: 26.", 26, ["application"])).toBe(true)
  })
})

describe("mentionsDollars", () => {
  it("finds $45, $45.00 and 45.00 for 4,500 cents, and $1,234.50", () => {
    expect(mentionsDollars("They brought in $45.", 4_500)).toBe(true)
    expect(mentionsDollars("Total: 45.00", 4_500)).toBe(true)
    expect(mentionsDollars("$1,234.50 this month", 123_450)).toBe(true)
    expect(mentionsDollars("$145.00", 4_500)).toBe(false)
  })
})
