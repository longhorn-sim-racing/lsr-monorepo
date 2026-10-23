/**
 * Pure helpers for scripts/jack-eval.ts (#161): which database the eval may run against (the local-only
 * check scripts use the same test), how its checks read numbers out of an answer, and its rooms' id
 * prefix. Here rather than in the scripts so they're unit-tested. No imports, no environment: the
 * scripts pass everything in.
 */

/**
 * Every eval room's id starts with this; real rooms have uuids. The eval's cleanup finds its rooms by
 * it, and officers' room lists leave them out (their pages and actions only take uuids)
 */
export const EVAL_ROOM_PREFIX = "jack-eval-"

// ---------------------------------------------------------------------------
// which database
// ---------------------------------------------------------------------------

const LOCAL_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"]

/**
 * Connection-string parameters that point the connection somewhere other than the URL's host: Prisma
 * and libpq honor `?host=` (and libpq `hostaddr` and `service`) over it, so
 * postgresql://…@localhost/postgres?host=<elsewhere> isn't local at all
 */
const HOST_OVERRIDES = ["host", "hostaddr", "service"]

type DbTarget = {
  host: string
  port: string
  database: string
  projectRef: string | null
  /** A query parameter that would send the connection elsewhere (HOST_OVERRIDES), if the URL has one */
  hostOverride: string | null
}

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
    hostOverride: [...parsed.searchParams.keys()].find((key) => HOST_OVERRIDES.includes(key.toLowerCase())) ?? null,
  }
}

/**
 * The same connection string pointed at another database on the same server: the eval's `--db` and
 * `jack:eval:prepare` use it for the lsr_eval copy. Null when it isn't a postgres:// URL or the name
 * isn't a plain identifier
 */
export function withDatabaseName(url: string | undefined, name: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name) || !parseDatabaseUrl(url)) return null
  const parsed = new URL(url!.trim())
  parsed.pathname = `/${name}`
  return parsed.toString()
}

/**
 * The eval copy's URL (`jack:eval:prepare`, and the eval's `--db`): DATABASE_URL's server, which must be
 * this machine, with the database `name`, which must start with lsr_eval, so a slip can't migrate or
 * seed the dev database
 */
export function evalCopyUrl(databaseUrl: string | undefined, name: string): { ok: true; url: string } | { ok: false; error: string } {
  if (!/^lsr_eval\w*$/.test(name)) return { ok: false, error: `--db must name an eval copy (lsr_eval, or a name that starts with lsr_eval), not "${name}".` }
  const problem = localDatabaseProblem("DATABASE_URL", databaseUrl)
  if (problem) return { ok: false, error: `Refusing to run: ${problem}` }
  const url = withDatabaseName(databaseUrl, name)
  return url ? { ok: true, url } : { ok: false, error: "DATABASE_URL isn't a postgres:// URL." }
}

const overrideProblem = (name: string, key: string) =>
  `${name} sets ${key}= in its query string, which would connect somewhere other than the host it names. Take it out (these scripts only run on a database named by its URL's host).`

/**
 * Why a URL isn't this machine's database, for the local-only check scripts; null when it is
 * (127.0.0.1 or localhost, with no host override in its query string)
 */
export function localDatabaseProblem(name: string, url: string | undefined): string | null {
  const target = parseDatabaseUrl(url)
  if (!target) return `${name} isn't set (or isn't a postgres:// URL).`
  if (target.hostOverride) return overrideProblem(name, target.hostOverride)
  if (!LOCAL_HOSTS.includes(target.host)) return `${name} points at ${target.host}, not the local database (127.0.0.1 or localhost).`
  return null
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
  if (main.hostOverride) return { ok: false, error: `Refusing to run: ${overrideProblem("DATABASE_URL", main.hostOverride)}` }
  const local = LOCAL_HOSTS.includes(main.host)
  // A Supabase pooler host is shared by every project in its region, so the flag names the project too
  const remoteName = main.projectRef ? `${main.host}/${main.projectRef}` : main.host
  if (!local && allowRemote?.toLowerCase() !== remoteName.toLowerCase()) {
    return {
      ok: false,
      error:
        `Refusing to run: DATABASE_URL points at ${main.host}, not this machine (127.0.0.1 or localhost). ` +
        `The eval writes to the database it runs on (a draft event and an audit entry, then deletes them). ` +
        `To run it on a copy of the data anyway, pass --allow-remote=${remoteName}. Never point it at production.`,
    }
  }
  const jack = parseDatabaseUrl(env.JACK_DATABASE_URL)
  if (!jack) {
    return {
      ok: false,
      error: "JACK_DATABASE_URL isn't set. The eval runs Jack's SQL tools as jack_readonly on the same database (scripts/jack-local-sql-role.ts sets it up locally).",
    }
  }
  if (jack.hostOverride) return { ok: false, error: `Refusing to run: ${overrideProblem("JACK_DATABASE_URL", jack.hostOverride)}` }
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
/**
 * A day range's other end, written tight with an en dash or hyphen ("1–13", "1-13"). A spaced dash or
 * an em dash starts something else, so "Oct 10 – 0 registered" and "Sep 3—45 people" keep their counts
 */
const RANGE_END = String.raw`(?:[–-]\d{1,2}(?:st|nd|rd|th)?)?`
const RANGE_START = String.raw`(?:\d{1,2}(?:st|nd|rd|th)?[–-])?`
/** "Oct 13", "October 13th, 2026", "Oct 1–13": the month first */
const MONTH_THEN_DAY = new RegExp(String.raw`\b(?:${MONTHS})\.?\s+\d{1,2}(?:st|nd|rd|th)?${RANGE_END}\b` + YEAR_AFTER, "gi")
/** "13 October", "13th of Oct, 2026", "1–13 Oct": the day first. May is matched apart (below) */
const DAY_THEN_MONTH = new RegExp(String.raw`\b${RANGE_START}\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:${MONTHS.replace("|may|", "|")})\b\.?` + YEAR_AFTER, "gi")
/** "13 May", only capitalized: "13 may have paid" isn't a date */
const DAY_THEN_MAY = new RegExp(String.raw`\b${RANGE_START}\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?May\b` + YEAR_AFTER, "g")

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

/** Ways of saying none, which count as zero only right before what they count ("No drivers have paid") */
const NONE_WORDS = ["no one", "no-one", "nobody", "nothing", "none", "no"]

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
  // Bold and code marks off, so "**15** forms" sits next to its noun like "15 forms"
  const clean = stripDatesAndTimes(text.replace(/\*\*|__|`/g, ""))
  const forms = numberForms(n)
  if (forms.some((form) => new RegExp(standalone(form), "i").test(clean))) {
    if (!nouns.length) return true
    if (nextToNoun(clean, forms, nouns) || otherNumbers(clean, n).length === 0) return true
  }
  // Zero said in words: "no drivers", "none of the applicants", "nobody has paid". Only right before one
  // of the nouns, and only when no other count sits next to those nouns ("5 drivers paid; no other drivers")
  if (n !== 0 || !nouns.length) return false
  const said = NONE_WORDS.some((word) =>
    nouns.some((noun) =>
      new RegExp(
        `(?<![\\w'’-])${word}(?:['’]s)?(?:\\s+(?:of|the|them|our|other|new|more|lsc|club|current|this|season's|paid|unpaid|active|confirmed|completed))*\\s+(?:(?:has|have|had|is|are|was|were)(?:\\s+been)?\\s+)?\\b${escapeRegExp(noun)}[\\w'’-]*(?=\\s+(?:have|has|had|are|were|is|was|yet|so|paid|entered|signed|registered|applied|on|in|this|for|at)\\b|\\s*[.,;:!)]|\\s*$)`,
        "i",
      ).test(clean),
    ),
  )
  if (!said) return false
  // Another count by the same nouns, in digits or words, means the "no" isn't the answer ("no one" isn't a one)
  const counted = clean.replace(/\bno[ -]one\b/gi, "nobody")
  const wordCounts = WORDS.slice(1).filter((w) => new RegExp(standalone(w), "i").test(counted))
  const others = [...new Set([...otherNumbers(clean, 0).map(String), ...wordCounts])]
  return !(others.length && nextToNoun(counted, others, nouns))
}

/** "$45", "$45.00" or "45.00" for 4,500 cents */
export function mentionsDollars(text: string, cents: number): boolean {
  const dollars = cents / 100
  const forms = [dollars.toFixed(2), dollars.toLocaleString("en-US", { minimumFractionDigits: 2 })]
  if (Number.isInteger(dollars)) forms.push(`$${dollars}`, `$${dollars.toLocaleString("en-US")}`)
  return forms.some((form) => new RegExp(`(?<![\\d.])${escapeRegExp(form)}(?![\\d])`).test(plain(text)))
}
