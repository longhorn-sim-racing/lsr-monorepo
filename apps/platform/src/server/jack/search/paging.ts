/**
 * Paging for `read` (design §7.3): a long text comes back a page at a time with the offset of the
 * next page, its total length and an outline of its headings, or as just the passages that match a
 * query. Pure, so the tests cover it directly.
 */

/** How much one read returns by default, and at most, in characters */
export const READ_DEFAULT_CHARS = 15_000
export const READ_MAX_CHARS = 25_000

export type TextPage = {
  text: string
  /** Where this page starts */
  offset: number
  /** Where the next page starts; null when this is the end */
  nextOffset: number | null
  /** The whole text's length */
  total: number
}

/**
 * The page of `text` starting at `offset`, at most `maxChars` long. It ends at a paragraph, line or
 * sentence break near the limit when there's one, never inside a character made of two code units.
 */
export function pageOf(text: string, offset: number, maxChars: number): TextPage {
  const total = text.length
  const start = Math.min(Math.max(0, Math.floor(offset)), total)
  if (start >= total) return { text: "", offset: start, nextOffset: null, total }
  let end = Math.min(total, start + Math.max(1, Math.floor(maxChars)))
  if (end < total) end = breakPoint(text, start, end)
  if (end < total && end > start + 1 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1
  return { text: text.slice(start, end), offset: start, nextOffset: end < total ? end : null, total }
}

/** The last blank line, line break, sentence end or space in the page's last fifth; else the hard limit */
function breakPoint(text: string, start: number, end: number): number {
  const floor = start + Math.floor((end - start) * 0.8)
  for (const separator of ["\n\n", "\n", ". ", " "]) {
    const at = text.lastIndexOf(separator, end - separator.length)
    if (at >= floor) return at + separator.length
  }
  return end
}

function isHighSurrogate(code: number) {
  return code >= 0xd800 && code <= 0xdbff
}

export type OutlineEntry = { heading: string; level: number; offset: number }

/** The most headings an outline lists */
export const OUTLINE_MAX = 40

/** The text's Markdown headings ("# …" to "###### …") with where each starts, skipping code blocks */
export function outlineOf(text: string, max = OUTLINE_MAX): OutlineEntry[] {
  const entries: OutlineEntry[] = []
  let offset = 0
  let fenced = false
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    else if (!fenced) {
      const match = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/.exec(line)
      if (match) {
        entries.push({ heading: match[2].trim().slice(0, 120), level: match[1].length, offset })
        if (entries.length >= max) break
      }
    }
    offset += line.length + 1
  }
  return entries
}

const STOP_WORDS = new Set(
  "a an and are as at be by did do does for from had has have how i in is it its me my of on or our that the their this to us was we were what when where which who why will with you".split(" "),
)

/** The words of a query worth looking for, lowercased, without stop words or duplicates */
export function queryTerms(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word) && word !== "or")
  return [...new Set(words)]
}

/** Matches a word and its usual endings ("sponsors" finds sponsor, sponsorship): its first few letters, at a word start */
function termPattern(term: string): RegExp {
  const stem = term.length > 5 ? term.slice(0, Math.max(5, term.length - 3)) : term
  return new RegExp(`(?<![\\p{L}\\p{N}])${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "giu")
}

/** The longest passage a match returns; longer paragraphs are cut into pieces */
const PASSAGE_CHARS = 1_500

type Block = { offset: number; text: string }

/** Paragraphs (blank-line separated), long ones cut at line breaks or at PASSAGE_CHARS */
function blocksOf(text: string): Block[] {
  const blocks: Block[] = []
  const re = /\S[\s\S]*?(?=\n[ \t]*\n|$)/g
  for (let match = re.exec(text); match; match = re.exec(text)) {
    let start = match.index
    const end = start + match[0].length
    while (start < end) {
      let stop = Math.min(end, start + PASSAGE_CHARS)
      if (stop < end) {
        const line = text.lastIndexOf("\n", stop)
        if (line > start + PASSAGE_CHARS / 2) stop = line
      }
      const piece = text.slice(start, stop).trim()
      if (piece) blocks.push({ offset: start, text: piece })
      start = stop
    }
    if (re.lastIndex === match.index) re.lastIndex++
  }
  return blocks
}

export type PassageMatch = {
  /** In document order, each with where it starts */
  passages: { offset: number; text: string }[]
  /** How many passages matched in all (more than `passages` when they didn't all fit) */
  matched: number
}

/**
 * The passages of `text` that match a query, best first until `maxChars` is used, then put back in
 * document order. A passage scores one point per query word it has (words in quotes together count
 * double), plus a little for each repeat.
 */
export function findPassages(text: string, query: string, maxChars: number): PassageMatch {
  const terms = queryTerms(query)
  if (!terms.length) return { passages: [], matched: 0 }
  const phrases = [...query.matchAll(/"([^"]+)"/g)].map((m) => m[1].trim().toLowerCase()).filter((p) => p.includes(" "))
  const patterns = terms.map(termPattern)

  const scored = blocksOf(text)
    .map((block) => {
      const lower = block.text.toLowerCase()
      let score = 0
      for (const pattern of patterns) {
        const hits = lower.match(pattern)?.length ?? 0
        if (hits) score += 1 + Math.min(hits - 1, 5) * 0.1
      }
      for (const phrase of phrases) if (lower.includes(phrase)) score += 2
      return { ...block, score }
    })
    .filter((block) => block.score > 0)

  const kept: (Block & { score: number })[] = []
  let used = 0
  for (const block of [...scored].sort((a, b) => b.score - a.score || a.offset - b.offset)) {
    if (used + block.text.length > maxChars && kept.length) continue
    const text = block.text.length > maxChars ? block.text.slice(0, maxChars) : block.text
    kept.push({ ...block, text })
    used += text.length
    if (used >= maxChars) break
  }
  return { passages: kept.sort((a, b) => a.offset - b.offset).map(({ offset, text }) => ({ offset, text })), matched: scored.length }
}
