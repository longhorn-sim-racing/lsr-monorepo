/**
 * The subset of OData filters Vercel's Web Analytics API takes (research/vercel-analytics.md §3), for
 * the fake: eq, ne, in, and, or, not, parentheses and startswith(field,'x'), single-quoted strings with
 * '' for a quote. Parse errors and fields Vercel doesn't filter on come back as messages for a 400.
 */

export type Event = Record<string, string | null>
export type Predicate = (event: Event) => boolean

/** Fields Vercel filters and groups on (requestHostname isn't one) */
export const FILTER_FIELDS = [
  "country",
  "deviceType",
  "environment",
  "requestPath",
  "referrerHostname",
  "osName",
  "browserName",
  "route",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "utmContent",
  "utmTerm",
] as const

type Token = { kind: "word" | "string" | "punct"; value: string }

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (/\s/.test(c)) {
      i += 1
    } else if (c === "(" || c === ")" || c === ",") {
      tokens.push({ kind: "punct", value: c })
      i += 1
    } else if (c === "'") {
      let value = ""
      i += 1
      for (;;) {
        if (i >= text.length) throw new Error("Unterminated string in filter")
        if (text[i] === "'" && text[i + 1] === "'") {
          value += "'"
          i += 2
        } else if (text[i] === "'") {
          i += 1
          break
        } else {
          value += text[i]
          i += 1
        }
      }
      tokens.push({ kind: "string", value })
    } else {
      const match = /^[A-Za-z_][A-Za-z0-9_/]*/.exec(text.slice(i))
      if (!match) throw new Error(`Unexpected "${c}" in filter`)
      tokens.push({ kind: "word", value: match[0] })
      i += match[0].length
    }
  }
  return tokens
}

/** A predicate for the filter, or throws with a message fit for a 400 */
export function parseFilter(text: string): Predicate {
  const tokens = tokenize(text)
  let at = 0
  const peek = () => tokens[at]
  const next = () => tokens[at++]
  const expect = (value: string) => {
    const token = next()
    if (token?.value !== value) throw new Error(`Expected "${value}" in filter`)
  }
  const field = (): string => {
    const token = next()
    if (token?.kind !== "word") throw new Error("Expected a field in filter")
    if (!(FILTER_FIELDS as readonly string[]).includes(token.value)) throw new Error(`Unsupported subject "${token.value}". Supported subjects: ${FILTER_FIELDS.join(", ")}`)
    return token.value
  }
  const string = (): string => {
    const token = next()
    if (token?.kind !== "string") throw new Error("Expected a quoted string in filter")
    return token.value
  }

  const primary = (): Predicate => {
    const token = peek()
    if (token?.value === "(") {
      next()
      const inner = or()
      expect(")")
      return inner
    }
    if (token?.kind === "word" && token.value === "startswith") {
      next()
      expect("(")
      const name = field()
      expect(",")
      const prefix = string()
      expect(")")
      return (event) => (event[name] ?? "").startsWith(prefix)
    }
    const name = field()
    const op = next()
    if (op?.value === "eq" || op?.value === "ne") {
      const value = string()
      return op.value === "eq" ? (event) => event[name] === value : (event) => event[name] !== value
    }
    if (op?.value === "in") {
      expect("(")
      const values = [string()]
      while (peek()?.value === ",") {
        next()
        values.push(string())
      }
      expect(")")
      return (event) => values.includes(event[name] ?? "")
    }
    throw new Error(`Unsupported operator "${op?.value ?? ""}" in filter`)
  }
  const unary = (): Predicate => {
    if (peek()?.value === "not") {
      next()
      const inner = unary()
      return (event) => !inner(event)
    }
    return primary()
  }
  const and = (): Predicate => {
    let left = unary()
    while (peek()?.value === "and") {
      next()
      const l = left
      const r = unary()
      left = (event) => l(event) && r(event)
    }
    return left
  }
  const or = (): Predicate => {
    let left = and()
    while (peek()?.value === "or") {
      next()
      const l = left
      const r = and()
      left = (event) => l(event) || r(event)
    }
    return left
  }

  const predicate = or()
  if (at < tokens.length) throw new Error(`Unexpected "${tokens[at].value}" in filter`)
  return predicate
}

/** Whether a filter names a field (so the production-only default doesn't apply when it names environment) */
export const mentions = (filter: string, name: string) => new RegExp(`\\b${name}\\b`).test(filter)
