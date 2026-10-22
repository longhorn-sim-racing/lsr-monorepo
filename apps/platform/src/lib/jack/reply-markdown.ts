/**
 * The light Markdown in Jack's replies (#185), parsed into a small tree the room draws as React
 * elements. Nothing here is ever HTML. It covers paragraphs, "- " and "1." lists (nested by indent),
 * fenced code, headings (drawn as bold lines), rules, **bold**, *italics*, `code`, [links](url), and
 * bare links (https://… and site paths like /admin/…). Anything else stays as written.
 *
 * `streaming` is for the end of a reply that's still coming in: a mark left open there covers the
 * rest of the text, and a half-typed marker (a lone "-" or "**") is held back, so marks never flash
 * on screen before turning into formatting.
 */

export type MdInline =
  | { kind: "text"; text: string }
  | { kind: "strong" | "em"; children: MdInline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; children: MdInline[] }

export type MdList = { kind: "list"; ordered: boolean; start: number; items: MdListItem[] }
export type MdListItem = { children: MdInline[]; lists: MdList[] }

export type MdBlock =
  | { kind: "paragraph" | "heading"; children: MdInline[] }
  | { kind: "code"; text: string }
  | { kind: "rule" }
  | MdList

const BULLET = /^( *)[-*•]\s+(.*)$/
const ORDERED = /^( *)(\d{1,3})[.)]\s+(.*)$/
const HEADING = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/
const RULE = /^ {0,3}([-*_])(?: *\1){2,}\s*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
/** The start of a block marker with nothing after it yet: held back while it streams */
const HALF_MARKER = /^\s*(?:[-*_•]{1,2}|\d{1,3}[.)]?|#{1,6}|`{1,2}|~{1,2})\s*$/

/** Where a list item's continuation lines start: indented at least this far, they belong to the item */
const CONTINUATION_INDENT = 2

type RawItem = { lines: string[]; lists: RawList[] }
type RawList = { kind: "list"; ordered: boolean; start: number; indent: number; items: RawItem[] }
type RawBlock = { kind: "paragraph" | "heading"; text: string } | { kind: "code"; text: string } | { kind: "rule" } | RawList

export function parseReply(text: string, streaming = false): MdBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n")
  if (streaming && lines.length && HALF_MARKER.test(lines[lines.length - 1])) lines.pop()

  const blocks: RawBlock[] = []
  let paragraph: string[] = []
  /** The open lists, outermost first; empty when the last block isn't a list */
  let stack: RawList[] = []

  const endParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join("\n") })
    paragraph = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) {
      endParagraph()
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      endParagraph()
      stack = []
      const body: string[] = []
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) body.push(lines[i])
      blocks.push({ kind: "code", text: body.join("\n") })
      continue
    }
    if (RULE.test(line)) {
      endParagraph()
      stack = []
      blocks.push({ kind: "rule" })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      endParagraph()
      stack = []
      blocks.push({ kind: "heading", text: heading[1] })
      continue
    }

    const bullet = BULLET.exec(line)
    const ordered = bullet ? null : ORDERED.exec(line)
    if (bullet || ordered) {
      endParagraph()
      const indent = (bullet ?? ordered)![1].length
      const item: RawItem = { lines: [bullet ? bullet[2] : ordered![3]], lists: [] }
      const isOrdered = Boolean(ordered)
      const newList = (): RawList => ({ kind: "list", ordered: isOrdered, start: ordered ? Number(ordered[2]) : 1, indent, items: [item] })

      // Back out of lists nested deeper than this item
      while (stack.length > 1 && indent < stack[stack.length - 1].indent - 1) stack.pop()
      const top = stack[stack.length - 1]
      if (top && indent >= top.indent + CONTINUATION_INDENT) {
        const list = newList()
        top.items[top.items.length - 1].lists.push(list)
        stack.push(list)
      } else if (top && top.ordered === isOrdered) {
        top.items.push(item)
      } else if (top && stack.length > 1) {
        // A different kind of list at the same depth: a new list in the same parent item
        const list = newList()
        stack[stack.length - 2].items.at(-1)!.lists.push(list)
        stack[stack.length - 1] = list
      } else {
        const list = newList()
        blocks.push(list)
        stack = [list]
      }
      continue
    }

    // An indented line under a list item continues it (after a blank line too). An unindented one ends
    // the list: in a chat reply that's the sentence after it ("Want the details?"), not more of the item
    const indent = line.length - line.trimStart().length
    if (stack.length && indent >= CONTINUATION_INDENT) {
      stack[stack.length - 1].items.at(-1)!.lines.push(line.trim())
      continue
    }
    stack = []
    paragraph.push(line)
  }
  endParagraph()

  // Only the text at the very end is still streaming, so only it may have marks left open
  const last = lastText(blocks)
  return blocks.map((block) => toBlock(block, streaming ? last : null))
}

/** The raw text that ends the reply: the last paragraph or heading, or the deepest last list item */
function lastText(blocks: RawBlock[]): RawItem | RawBlock | null {
  let block = blocks[blocks.length - 1]
  if (!block) return null
  while (block.kind === "list") {
    const item = block.items[block.items.length - 1]
    if (!item.lists.length) return item
    block = item.lists[item.lists.length - 1]
  }
  return block
}

function toBlock(block: RawBlock, open: RawItem | RawBlock | null): MdBlock {
  switch (block.kind) {
    case "paragraph":
    case "heading":
      return { kind: block.kind, children: parseInline(block.text, block === open) }
    case "code":
    case "rule":
      return block
    case "list":
      return toList(block, open)
  }
}

function toList(list: RawList, open: RawItem | RawBlock | null): MdList {
  return {
    kind: "list",
    ordered: list.ordered,
    start: list.start,
    items: list.items.map((item) => ({
      children: parseInline(item.lines.join("\n"), item === open),
      lists: item.lists.map((sub) => toList(sub, open)),
    })),
  }
}

/** Letters and digits: `_` inside a word (snake_case) is never a mark */
const WORD_CHAR = /[A-Za-z0-9\u00C0-\u024F]/
const LINK = /^\[([^\]\n]+)\]\(\s*([^()\s]+)\s*\)/
/** A link still being written at the end of a streaming reply: its label shows, its brackets don't */
const PARTIAL_LINK = /^\[([^\]\n]*)(?:\]\(?[^)\s]*)?$/
const BARE_URL = /^https?:\/\/[^\s<>"'`]+/
/** A site path such as /admin/jack/decks/abc, which is how Jack's tools give links */
const SITE_PATH = /^\/[a-z][\w\-./?=&%#~]*/i
const TRAILING_PUNCTUATION = /[.,;:!?*_'"\]]+$/
const ESCAPABLE = /[\\`*_[\]()#\-.!]/

/** Inline marks in one block's text. `open`: the text is the end of a reply that's still streaming */
export function parseInline(text: string, open = false): MdInline[] {
  return inline(text, open, true)
}

/** `links` is off inside a link's label, since a link can't hold another */
function inline(text: string, open: boolean, links: boolean): MdInline[] {
  const out: MdInline[] = []
  let plain = ""
  const push = (...nodes: MdInline[]) => {
    if (plain) out.push({ kind: "text", text: plain })
    plain = ""
    out.push(...nodes)
  }

  let i = 0
  while (i < text.length) {
    const ch = text[i]
    const atWordStart = i === 0 || /[\s([]/.test(text[i - 1])

    if (ch === "\\" && i + 1 < text.length && ESCAPABLE.test(text[i + 1])) {
      plain += text[i + 1]
      i += 2
      continue
    }

    if (ch === "`") {
      const end = text.indexOf("`", i + 1)
      if (end > i + 1) {
        push({ kind: "code", text: text.slice(i + 1, end) })
        i = end + 1
        continue
      }
      if (end === -1 && open) {
        const rest = text.slice(i + 1)
        push(...(rest ? [{ kind: "code" as const, text: rest }] : []))
        break
      }
    }

    if (ch === "[") {
      const link = LINK.exec(text.slice(i))
      if (link) {
        const href = links ? safeHref(link[2]) : null
        const label = inline(link[1], false, false)
        push(...(href ? [{ kind: "link" as const, href, children: label }] : label))
        i += link[0].length
        continue
      }
      const partial = open ? PARTIAL_LINK.exec(text.slice(i)) : null
      if (partial) {
        push(...inline(partial[1], true, false))
        break
      }
    }

    if (ch === "*" || ch === "_") {
      const mark = emphasis(text, i, open, links)
      if (mark) {
        push(...mark.nodes)
        i = mark.end
        continue
      }
    }

    if (links && atWordStart && (ch === "h" || ch === "/")) {
      const match = (ch === "h" ? BARE_URL : SITE_PATH).exec(text.slice(i))
      if (match) {
        const href = trimUrl(match[0])
        const safe = safeHref(href)
        if (safe) {
          push({ kind: "link", href: safe, children: [{ kind: "text", text: href }] })
          i += href.length
          continue
        }
      }
    }

    plain += ch
    i++
  }
  push()
  return out
}

/**
 * Bold (`**`, `__`) or italics (`*`, `_`) starting at `i`, if it opens a mark there. A mark opens
 * before a non-space and closes after one; `_` also has to sit at a word's edge.
 */
function emphasis(text: string, i: number, open: boolean, links: boolean): { nodes: MdInline[]; end: number } | null {
  const ch = text[i]
  const double = text[i + 1] === ch
  const size = double ? 2 : 1
  const start = i + size
  const kind = double ? "strong" : "em"

  // A mark typed at the very end of a streaming reply: hold it back until its text arrives
  if (open && /^[*_]*$/.test(text.slice(i))) return { nodes: [], end: text.length }
  if (!text[start] || /\s/.test(text[start])) return null
  if (ch === "_" && i > 0 && WORD_CHAR.test(text[i - 1])) return null
  if (double && text[start] === ch) return null

  for (let j = text.indexOf(ch, start + 1); j !== -1; j = text.indexOf(ch, j + 1)) {
    if (double ? text[j + 1] !== ch : text[j + 1] === ch || text[j - 1] === ch) continue
    if (/\s/.test(text[j - 1])) continue
    if (ch === "_" && WORD_CHAR.test(text[j + size] ?? "")) continue
    return { nodes: [{ kind, children: inline(text.slice(start, j), false, links) }], end: j + size }
  }
  if (!open) return null
  // Still streaming: the mark covers the rest, less a closing mark that's half typed
  return { nodes: [{ kind, children: inline(text.slice(start).replace(/[*_]+$/, ""), true, links) }], end: text.length }
}

/** A bare link without the punctuation after it ("see https://x.com." links https://x.com) */
function trimUrl(url: string): string {
  let trimmed = url.replace(TRAILING_PUNCTUATION, "")
  // A closing parenthesis belongs to the link only if it opened one
  while (trimmed.endsWith(")") && (trimmed.match(/\(/g)?.length ?? 0) < (trimmed.match(/\)/g)?.length ?? 0)) trimmed = trimmed.slice(0, -1).replace(TRAILING_PUNCTUATION, "")
  return trimmed
}

/** Links go to the web, email, or a page on this site; anything else (javascript:, data:) isn't a link */
export function safeHref(href: string): string | null {
  if (/^\/(?![/\\])/.test(href)) return href
  try {
    const { protocol } = new URL(href)
    return protocol === "https:" || protocol === "http:" || protocol === "mailto:" ? href : null
  } catch {
    return null
  }
}
