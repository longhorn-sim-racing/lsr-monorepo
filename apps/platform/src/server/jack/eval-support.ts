/**
 * Pure helpers for scripts/jack-eval.ts (#161): which database the eval may run against, and how its
 * checks read numbers out of an answer. Here rather than in the script so they're unit-tested. No
 * imports, no environment: the script passes everything in.
 */

// ---------------------------------------------------------------------------
// which database
// ---------------------------------------------------------------------------

const LOCAL_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"]

type DbTarget = { host: string; port: string; database: string; projectRef: string | null }

/** Host, port and database of a Postgres URL; the Supabase project ref when the user is `role.<ref>` (the pooler's form). Null if it isn't one */
export function parseDatabaseUrl(url: string | undefined): DbTarget | null {
  if (!url?.trim()) return null
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return null
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol) || !parsed.hostname) return null
  const user = decodeURIComponent(parsed.username)
  const dot = user.indexOf(".")
  return {
    host: parsed.hostname.toLowerCase(),
    port: parsed.port || "5432",
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")) || "(default)",
    projectRef: dot > 0 ? user.slice(dot + 1) : null,
  }
}

export type EvalDatabase = { ok: true; host: string; port: string; database: string; local: boolean } | { ok: false; error: string }

/**
 * Whether the eval may run: DATABASE_URL must be this machine (127.0.0.1 or localhost), unless
 * `allowRemote` names its host exactly, and JACK_DATABASE_URL must be the same host and database
 * (and Supabase project, for pooler URLs), so the read-only role reads the data the checks compare to.
 * The eval writes (a draft event and its audit entry, which it then deletes) and a real run costs money.
 */
export function checkEvalDatabase(env: { DATABASE_URL?: string; JACK_DATABASE_URL?: string }, allowRemote?: string): EvalDatabase {
  const main = parseDatabaseUrl(env.DATABASE_URL)
  if (!main) return { ok: false, error: "DATABASE_URL isn't set (or isn't a postgres:// URL) in the environment or apps/platform/.env.local / .env." }
  const local = LOCAL_HOSTS.includes(main.host)
  if (!local && allowRemote?.toLowerCase() !== main.host) {
    return {
      ok: false,
      error:
        `Refusing to run: DATABASE_URL points at ${main.host}, not this machine (127.0.0.1 or localhost). ` +
        `The eval writes to the database it runs on (a draft event and an audit entry, then deletes them). ` +
        `To run it on a copy of the data anyway, pass --allow-remote=${main.host}. Never point it at production.`,
    }
  }
  const jack = parseDatabaseUrl(env.JACK_DATABASE_URL)
  if (!jack) {
    return {
      ok: false,
      error: "JACK_DATABASE_URL isn't set. The eval runs Jack's SQL tools as jack_readonly on the same database (scripts/jack-local-sql-role.ts sets it up locally).",
    }
  }
  const mismatch =
    jack.host !== main.host
      ? `host ${jack.host}`
      : jack.database !== main.database
        ? `database ${jack.database}`
        : jack.projectRef && main.projectRef && jack.projectRef !== main.projectRef
          ? `Supabase project ${jack.projectRef}`
          : null
  if (mismatch) {
    return {
      ok: false,
      error: `Refusing to run: JACK_DATABASE_URL points at ${mismatch}, but DATABASE_URL is ${main.host}/${main.database}${main.projectRef ? ` (project ${main.projectRef})` : ""}. They have to be the same database, or Jack reads different data than the checks do.`,
    }
  }
  return { ok: true, host: main.host, port: main.port, database: main.database, local }
}

// ---------------------------------------------------------------------------
// reading numbers out of an answer
// ---------------------------------------------------------------------------

/** Spaces that Intl date formatting and models use, as plain spaces */
export function plain(text: string): string {
  return text.replace(/[\u00a0\u202f\u2009]/g, " ")
}

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?"
const YEAR_AFTER = String.raw`(?:,?\s+\d{4}\b)?`
/** "Oct 13", "October 13th, 2026": the month first */
const MONTH_THEN_DAY = new RegExp(String.raw`\b(?:${MONTHS})\.?\s+\d{1,2}(?:st|nd|rd|th)?\b` + YEAR_AFTER, "gi")
/** "13 October", "13th of Oct, 2026": the day first. May is matched apart (below) */
const DAY_THEN_MONTH = new RegExp(String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:${MONTHS.replace("|may|", "|")})\b\.?` + YEAR_AFTER, "gi")
/** "13 May", only capitalized: "13 may have paid" isn't a date */
const DAY_THEN_MAY = new RegExp(String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?May\b` + YEAR_AFTER, "g")

/**
 * The answer without its dates, times, years and clock values, so "Mon, Oct 13, 7:00 PM CT" doesn't
 * read as the numbers 13 and 7: ISO dates and times, 10/13 and 10/13/2026, Oct 13 and 13 October
 * (with or without a year), 7:00 and 19:00 (with or without AM/PM), 7 PM, and the years 1990 to 2039.
 */
export function stripDatesAndTimes(text: string): string {
  return plain(text)
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/gi, " ")
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, " ")
    .replace(MONTH_THEN_DAY, " ")
    .replace(DAY_THEN_MONTH, " ")
    .replace(DAY_THEN_MAY, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?/gi, " ")
    .replace(/\b\d{1,2}\s*[ap]\.?m\.?(?![a-z])/gi, " ")
    .replace(/\b(?:199\d|20[0-3]\d)\b/g, " ")
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"]

/** How a count can be written: 13, 1,234, and the words for 0 to 12 */
function numberForms(n: number): string[] {
  const forms = new Set([String(n), n.toLocaleString("en-US")])
  if (n >= 0 && n <= 12) forms.add(WORDS[n])
  return [...forms]
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** A count standing alone: not inside a longer number, a decimal, a dollar amount or a word */
function standalone(form: string): string {
  return `(?<![\\w.,$])${escapeRegExp(form)}(?![\\w]|[.,]\\d)`
}

const WORD = "[A-Za-z][\\w'’-]*"

/** The count right next to one of its nouns: "13 paid entries", "13 LSC applications", "applications: 13", "the total is 13" */
function nextToNoun(text: string, forms: string[], nouns: string[]): boolean {
  return forms.some((form) =>
    nouns.some((noun) => {
      const number = standalone(form)
      const word = `\\b${escapeRegExp(noun)}[\\w'’-]*`
      const after = new RegExp(`${number}(?:\\s+${WORD}){0,2}?\\s+${word}`, "i")
      const before = new RegExp(`${word}(?:\\s+${WORD})?\\s*(?:[:=—–]|\\s-\\s|\\b(?:is|are|was|were|totals?|totaled|of)\\b)\\s*${number}`, "i")
      return after.test(text) || before.test(text)
    })
  )
}

/** Other numbers the answer gives (digits only), once dates and times are out */
function otherNumbers(text: string, n: number): number[] {
  return [...text.matchAll(/(?<![\w.,$])\d[\d,]*(?:\.\d+)?(?![\w])/g)].map((m) => Number(m[0].replace(/,/g, ""))).filter((value) => value !== n)
}

/**
 * Whether an answer gives the count `n`. Dates, times and years don't count ("Oct 13, 7:00 PM" isn't
 * 13 or 7). With `nouns` (the words the count is of, matched as word starts: "application" matches
 * "applications"), the count has to sit next to one of them, unless it's the only number in the
 * answer, so "13 applications, 9 paid" passes for 13 applications but not for 13 paid.
 */
export function mentionsNumber(text: string, n: number, nouns: string[] = []): boolean {
  const clean = stripDatesAndTimes(text)
  const forms = numberForms(n)
  if (!forms.some((form) => new RegExp(standalone(form), "i").test(clean))) return false
  if (!nouns.length) return true
  return nextToNoun(clean, forms, nouns) || otherNumbers(clean, n).length === 0
}

/** "$45", "$45.00" or "45.00" for 4,500 cents */
export function mentionsDollars(text: string, cents: number): boolean {
  const dollars = cents / 100
  const forms = [dollars.toFixed(2), dollars.toLocaleString("en-US", { minimumFractionDigits: 2 })]
  if (Number.isInteger(dollars)) forms.push(`$${dollars}`, `$${dollars.toLocaleString("en-US")}`)
  return forms.some((form) => new RegExp(`(?<![\\d.])${escapeRegExp(form)}(?![\\d])`).test(plain(text)))
}
