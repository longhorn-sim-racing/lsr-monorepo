/**
 * The Drive fake's `q` and `fields` (research/google-drive.md §7): the subset of Drive's search
 * language Jack's client could send, and Drive's partial-response projection, so a missing `fields`
 * shows up in tests the way it would against the real API (only id, name and type come back).
 */

export class FakeQueryError extends Error {}

/** What a `q` term can look at */
export type QueryFile = { id: string; name: string; mimeType: string; parents: string[]; trashed: boolean; modifiedTime: string; text: string }

type Token = { type: "string"; value: string } | { type: "word"; value: string } | { type: "op"; value: string } | { type: "paren"; value: "(" | ")" }

function tokenize(q: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < q.length) {
    const char = q[i]
    if (/\s/.test(char)) {
      i++
    } else if (char === "'") {
      let value = ""
      i++
      for (;;) {
        if (i >= q.length) throw new FakeQueryError("Unterminated string")
        if (q[i] === "\\") {
          const next = q[i + 1]
          if (next !== "'" && next !== "\\") throw new FakeQueryError("Bad escape")
          value += next
          i += 2
        } else if (q[i] === "'") {
          i++
          break
        } else value += q[i++]
      }
      tokens.push({ type: "string", value })
    } else if (char === "(" || char === ")") {
      tokens.push({ type: "paren", value: char })
      i++
    } else if ("=!<>".includes(char)) {
      const two = q.slice(i, i + 2)
      const op = ["!=", "<=", ">="].includes(two) ? two : char
      if (op === "!") throw new FakeQueryError("Bad operator")
      tokens.push({ type: "op", value: op })
      i += op.length
    } else {
      const word = /^[A-Za-z_][\w]*/.exec(q.slice(i))?.[0]
      if (!word) throw new FakeQueryError(`Unexpected "${char}"`)
      tokens.push({ type: "word", value: word })
      i += word.length
    }
  }
  return tokens
}

type Predicate = (file: QueryFile) => boolean

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

/** Drive's fullText: whole-token matches; a "quoted phrase" must appear as consecutive tokens */
function fullTextMatch(file: QueryFile, query: string): boolean {
  const haystack = words(`${file.name} ${file.text}`)
  const phrase = /^"(.*)"$/.exec(query.trim())
  const needles = words(phrase ? phrase[1] : query)
  if (!needles.length) return false
  if (!phrase) return needles.every((needle) => haystack.includes(needle))
  return haystack.some((_, i) => needles.every((needle, j) => haystack[i + j] === needle))
}

/** Parses a `q` into a predicate; throws FakeQueryError (the fake answers 400 badRequest) for anything outside the supported subset */
export function parseDriveQuery(q: string): Predicate & { fullText: boolean } {
  const tokens = tokenize(q)
  let at = 0
  let usesFullText = false
  const peek = () => tokens[at]
  const isWord = (value: string) => peek()?.type === "word" && peek()!.value.toLowerCase() === value
  const take = () => {
    const token = tokens[at++]
    if (!token) throw new FakeQueryError("Unexpected end of query")
    return token
  }
  const expect = (type: Token["type"], value?: string) => {
    const token = take()
    if (token.type !== type || (value !== undefined && token.value !== value)) throw new FakeQueryError(`Expected ${value ?? type}`)
    return token.value
  }
  const string = () => expect("string")

  function or(): Predicate {
    let left = and()
    while (isWord("or")) {
      take()
      const a = left
      const b = and()
      left = (f) => a(f) || b(f)
    }
    return left
  }
  function and(): Predicate {
    let left = unary()
    while (isWord("and")) {
      take()
      const a = left
      const b = unary()
      left = (f) => a(f) && b(f)
    }
    return left
  }
  function unary(): Predicate {
    if (isWord("not")) {
      take()
      const inner = unary()
      return (f) => !inner(f)
    }
    if (peek()?.type === "paren" && peek()!.value === "(") {
      take()
      const inner = or()
      expect("paren", ")")
      return inner
    }
    return term()
  }
  function term(): Predicate {
    const first = take()
    if (first.type === "string") {
      if (!isWord("in")) throw new FakeQueryError("Expected in")
      take()
      if (!isWord("parents")) throw new FakeQueryError("Only 'id' in parents is supported")
      take()
      return (f) => f.parents.includes(first.value)
    }
    if (first.type !== "word") throw new FakeQueryError("Expected a field")
    const field = first.value
    if (field === "trashed") {
      const op = expect("op")
      const value = expect("word")
      if (!["=", "!="].includes(op) || !["true", "false"].includes(value)) throw new FakeQueryError("trashed takes = or != true/false")
      return (f) => (f.trashed === (value === "true")) === (op === "=")
    }
    if (field === "mimeType") {
      const op = expect("op")
      const value = string()
      if (!["=", "!="].includes(op)) throw new FakeQueryError("mimeType takes = or !=")
      return (f) => (f.mimeType === value) === (op === "=")
    }
    if (field === "name") {
      if (isWord("contains")) {
        take()
        const value = string().toLowerCase()
        return (f) => f.name.toLowerCase().includes(value)
      }
      const op = expect("op")
      const value = string()
      if (!["=", "!="].includes(op)) throw new FakeQueryError("name takes contains, = or !=")
      return (f) => (f.name === value) === (op === "=")
    }
    if (field === "fullText") {
      if (!isWord("contains")) throw new FakeQueryError("fullText only takes contains")
      take()
      const value = string()
      usesFullText = true
      return (f) => fullTextMatch(f, value)
    }
    if (field === "modifiedTime") {
      const op = expect("op")
      const value = Date.parse(string())
      if (!Number.isFinite(value)) throw new FakeQueryError("Bad date")
      const compare: Record<string, (a: number) => boolean> = { ">": (a) => a > value, ">=": (a) => a >= value, "<": (a) => a < value, "<=": (a) => a <= value, "=": (a) => a === value }
      const test = compare[op]
      if (!test) throw new FakeQueryError("Bad operator for modifiedTime")
      return (f) => test(Date.parse(f.modifiedTime))
    }
    throw new FakeQueryError(`Unsupported field ${field}`)
  }

  const predicate = or()
  if (at !== tokens.length) throw new FakeQueryError("Unexpected text after the query")
  return Object.assign(predicate, { fullText: usesFullText })
}

/** One requested field: a path ("capabilities/canDownload") with optional sub-fields ("files(id,name)") */
type FieldSelection = { path: string[]; sub: FieldSelection[] | null }

/** Parses Drive's `fields`: "nextPageToken,files(id,name,capabilities/canDownload)" */
export function parseFields(fields: string): FieldSelection[] {
  let at = 0
  function list(): FieldSelection[] {
    const out: FieldSelection[] = []
    for (;;) {
      const name = /^[\w*]+(?:\/[\w*]+)*/.exec(fields.slice(at))?.[0]
      if (!name) throw new FakeQueryError("Invalid field selection")
      at += name.length
      let sub: FieldSelection[] | null = null
      if (fields[at] === "(") {
        at++
        sub = list()
        if (fields[at] !== ")") throw new FakeQueryError("Invalid field selection")
        at++
      }
      out.push({ path: name.split("/"), sub })
      if (fields[at] !== ",") return out
      at++
    }
  }
  const parsed = list()
  if (at !== fields.length) throw new FakeQueryError("Invalid field selection")
  return parsed
}

/** The parts of `value` the selection names; "*" keeps everything at its level */
export function project(value: unknown, selection: FieldSelection[]): unknown {
  if (Array.isArray(value)) return value.map((item) => project(item, selection))
  if (!value || typeof value !== "object") return value
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const { path, sub } of selection) {
    if (path.length === 1 && path[0] === "*") return sub ? project(source, sub) : source
    const [head, ...rest] = path
    if (!(head in source)) continue
    const inner = rest.length ? project(source[head], [{ path: rest, sub }]) : sub ? project(source[head], sub) : source[head]
    if (inner === undefined) continue
    // Two selections under the same key ("capabilities/canDownload,capabilities/canEdit") merge
    const existing = out[head]
    out[head] = existing && typeof existing === "object" && inner && typeof inner === "object" && !Array.isArray(inner) ? { ...existing, ...inner } : inner
  }
  return out
}
