import remarkGfm from "remark-gfm"
import remarkMdx from "remark-mdx"
import remarkParse from "remark-parse"
import { unified, type Processor } from "unified"
import type { JackProposalPreview, MdPreviewAlign, MdPreviewBlock, MdPreviewInline, MdPreviewListItem } from "@/lib/jack/markdown-preview"

/**
 * Markdown in news proposals (design §4.3). The site renders a post's text as MDX (src/lib/news.ts,
 * with remark-gfm), where "<" starts a component, "{ }" run JavaScript and a line starting with import
 * or export is a module. Jack's posts are Markdown only, so none of these may appear outside code.
 *
 * Both the check and the card's preview use one parse: Markdown with GFM, read the way MDX reads it
 * (indented code, HTML and <autolinks> switched off, as MDX switches them off). So the code spans and
 * fenced blocks found here are exactly the ones MDX treats as code, and the preview shows the structure
 * the site will show. Nothing here runs MDX or produces HTML.
 *
 * An edit may keep what the officer's post already runs as MDX (an embed, say), found with MDX's own
 * parser, but only whole and unchanged: see keptMdx.
 */

/** The mdast nodes read here, typed only as far as used (mdast's own types aren't a dependency) */
type MdNode = {
  type: string
  value?: string
  url?: string
  alt?: string | null
  depth?: number
  ordered?: boolean | null
  start?: number | null
  checked?: boolean | null
  lang?: string | null
  align?: MdPreviewAlign[] | null
  identifier?: string
  label?: string | null
  children?: MdNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
}

/** Reads Markdown the way MDX does (micromark-extension-mdxjs switches these constructs off) */
function mdxMarkdown(this: Processor) {
  const data = this.data()
  ;(data.micromarkExtensions ??= []).push({ disable: { null: ["codeIndented", "htmlFlow", "htmlText", "autolink"] } })
}

const parser = unified().use(remarkParse).use(remarkGfm).use(mdxMarkdown)

export function parseMarkdown(text: string): MdNode {
  return parser.parse(text) as unknown as MdNode
}

function walk(node: MdNode, visit: (node: MdNode) => void) {
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

/** One place the text has something MDX would run, at `offset` */
export type MdxProblem = { offset: number; line: number; what: string; excerpt: string }

/** "<", "{", "}" outside code, and import/export lines: what MDX would treat as code. Empty when it's plain Markdown */
export function mdxProblems(text: string, tree: MdNode = parseMarkdown(text)): MdxProblem[] {
  const code: [number, number][] = []
  walk(tree, (node) => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if ((node.type === "code" || node.type === "inlineCode") && start !== undefined && end !== undefined) code.push([start, end])
  })
  code.sort((a, b) => a[0] - b[0])
  const inCode = (offset: number) => code.some(([start, end]) => offset >= start && offset < end)

  const problems: MdxProblem[] = []
  const lineStarts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1)
  const lineOf = (offset: number) => {
    let line = 0
    while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) line++
    return line
  }
  const lineEnd = (line: number) => (line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : text.length)
  const problem = (offset: number, what: string): MdxProblem => {
    const line = lineOf(offset)
    const from = lineStarts[line]
    const to = lineEnd(line)
    const start = Math.max(from, offset - 25)
    const end = Math.min(to, offset + 25)
    return { offset, line: line + 1, what, excerpt: `${start > from ? "…" : ""}${text.slice(start, end).trim()}${end < to ? "…" : ""}` }
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if ((ch === "<" || ch === "{" || ch === "}") && !inCode(i)) problems.push(problem(i, ch))
  }
  for (const start of lineStarts) {
    const match = /^[ \t]*(import|export)\s/.exec(text.slice(start, start + 20))
    const at = match ? start + match[0].indexOf(match[1]) : -1
    if (match && !inCode(at)) problems.push(problem(at, match[1]))
  }
  return problems.sort((a, b) => a.line - b.line)
}

/** The site's own parse (@mdx-js/mdx): Markdown, then MDX's components, expressions and import/export, then GFM */
const mdxParser = unified().use(remarkParse).use(remarkMdx).use(remarkGfm)

const MDX_NODES = new Set(["mdxJsxFlowElement", "mdxJsxTextElement", "mdxFlowExpression", "mdxTextExpression", "mdxjsEsm"])

type MdxPart = { start: number; end: number; source: string }

/**
 * Each outermost thing the site runs as MDX (an element with everything inside it, an expression, an
 * import or export), with its exact source text. Empty when the text isn't valid MDX
 */
function mdxParts(text: string): MdxPart[] {
  let tree: MdNode
  try {
    tree = mdxParser.parse(text) as unknown as MdNode
  } catch {
    return []
  }
  const parts: MdxPart[] = []
  const visit = (node: MdNode) => {
    if (MDX_NODES.has(node.type)) {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start !== undefined && end !== undefined) parts.push({ start, end, source: text.slice(start, end) })
      return
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(tree)
  return parts
}

/**
 * Where `text` keeps what `was` runs as MDX unchanged: a whole element (its tag, every attribute and
 * anything inside it), expression or import/export, character for character, and each only as many
 * times as `was` has it. MDX's parser finds where each one ends, so a tag over several lines (blank
 * lines included) is one part, and a new attribute makes it a different part
 */
function keptMdx(text: string, wasParts: MdxPart[]): [number, number][] {
  const left = new Map<string, number>()
  for (const part of wasParts) left.set(part.source, (left.get(part.source) ?? 0) + 1)
  if (!left.size) return []
  const kept: [number, number][] = []
  for (const part of mdxParts(text)) {
    const count = left.get(part.source) ?? 0
    if (!count) continue
    left.set(part.source, count - 1)
    kept.push([part.start, part.end])
  }
  return kept
}

/**
 * Why `text` can't go in a post, written for the model to fix it, or null when it's plain Markdown.
 * `was`: the post's text as it is now (an edit). What the site already runs as MDX there (an officer's
 * own embed, say) isn't Jack's to fix, so it may stay exactly as it is (keptMdx); anything an edit adds,
 * changes, copies or takes out of code is held to the rule
 */
export function mdxError(text: string, what = "The post's text", tree?: MdNode, was?: string): string | null {
  let problems = mdxProblems(text, tree)
  let hasOwn = false
  if (problems.length && was !== undefined) {
    const wasParts = mdxParts(was)
    hasOwn = wasParts.length > 0
    const kept = keptMdx(text, wasParts)
    problems = problems.filter((p) => !kept.some(([start, end]) => p.offset >= start && p.offset < end))
  }
  if (!problems.length) return null
  // One mention per line, naming each thing it has
  const lines = new Map<number, { what: Set<string>; excerpt: string }>()
  for (const p of problems) {
    const line = lines.get(p.line) ?? { what: new Set<string>(), excerpt: p.excerpt }
    line.what.add(p.what === "import" || p.what === "export" ? `a starting "${p.what}"` : `"${p.what}"`)
    lines.set(p.line, line)
  }
  const shown = [...lines.entries()]
    .slice(0, 3)
    .map(([n, line]) => `line ${n} has ${[...line.what].join(" and ")} (${line.excerpt})`)
    .join("; ")
  const more = lines.size > 3 ? ` and ${lines.size - 3} more lines` : ""
  const own = hasOwn ? " The HTML or components the post already has may stay exactly as they are, but an edit can't add one, change one (an attribute or anything inside it) or copy one." : ""
  return `${what} must be plain Markdown: the site shows it with MDX, where "<" starts a component, "{" and "}" run code, and a line starting with import or export is code. Here ${shown}${more}. Use Markdown instead (**bold**, [text](https://…), - lists), leave out HTML and braces, and put any of these characters inside \`code\` if they must show.${own}`
}

/** Most nodes a preview keeps; a post is at most 50,000 characters, so this is only a backstop */
const MAX_PREVIEW_NODES = 20_000

/**
 * The text as the card previews it: headings, paragraphs, lists, quotes, code, tables and links, as
 * the site's renderer structures them. Pictures stay links (the card never loads them)
 */
export function markdownPreview(text: string, meta: { label: string; title?: string; excerpt?: string }, tree: MdNode = parseMarkdown(text)): JackProposalPreview {
  const definitions = new Map<string, string>()
  walk(tree, (node) => {
    if (node.type === "definition" && node.identifier && node.url) definitions.set(node.identifier, node.url)
  })
  let budget = MAX_PREVIEW_NODES
  let truncated = false
  const spend = () => {
    if (budget <= 0) {
      truncated = true
      return false
    }
    budget--
    return true
  }

  const inlines = (nodes: MdNode[] = []): MdPreviewInline[] => {
    const out: MdPreviewInline[] = []
    for (const node of nodes) {
      if (!spend()) break
      switch (node.type) {
        case "text":
        case "html":
          out.push({ t: "text", v: node.value ?? "" })
          break
        case "emphasis":
          out.push({ t: "em", c: inlines(node.children) })
          break
        case "strong":
          out.push({ t: "strong", c: inlines(node.children) })
          break
        case "delete":
          out.push({ t: "del", c: inlines(node.children) })
          break
        case "inlineCode":
          out.push({ t: "code", v: node.value ?? "" })
          break
        case "break":
          out.push({ t: "br" })
          break
        case "link":
          out.push({ t: "link", url: node.url ?? "", c: inlines(node.children) })
          break
        case "linkReference": {
          const url = node.identifier ? definitions.get(node.identifier) : undefined
          out.push(...(url ? [{ t: "link" as const, url, c: inlines(node.children) }] : inlines(node.children)))
          break
        }
        case "image":
          out.push({ t: "image", url: node.url ?? "", alt: node.alt ?? "" })
          break
        case "imageReference": {
          const url = node.identifier ? definitions.get(node.identifier) : undefined
          out.push(url ? { t: "image", url, alt: node.alt ?? "" } : { t: "text", v: node.alt ?? "" })
          break
        }
        case "footnoteReference":
          out.push({ t: "text", v: `[${node.label ?? node.identifier ?? ""}]` })
          break
        default:
          if (node.children) out.push(...inlines(node.children))
          else if (node.value) out.push({ t: "text", v: node.value })
      }
    }
    return out
  }

  const blocks = (nodes: MdNode[] = []): MdPreviewBlock[] => {
    const out: MdPreviewBlock[] = []
    for (const node of nodes) {
      if (!spend()) break
      switch (node.type) {
        case "heading":
          out.push({ t: "h", depth: Math.min(Math.max(node.depth ?? 1, 1), 6), c: inlines(node.children) })
          break
        case "paragraph":
          out.push({ t: "p", c: inlines(node.children) })
          break
        case "code":
          out.push({ t: "code", ...(node.lang ? { lang: node.lang } : {}), v: node.value ?? "" })
          break
        case "blockquote":
          out.push({ t: "quote", c: blocks(node.children) })
          break
        case "list": {
          const items: MdPreviewListItem[] = (node.children ?? []).map((item) => ({ ...(typeof item.checked === "boolean" ? { checked: item.checked } : {}), c: blocks(item.children) }))
          const start = node.ordered && typeof node.start === "number" && node.start !== 1 ? node.start : undefined
          out.push({ t: "list", ordered: Boolean(node.ordered), ...(start !== undefined ? { start } : {}), items })
          break
        }
        case "table":
          out.push({ t: "table", align: node.align ?? [], rows: (node.children ?? []).map((row) => (row.children ?? []).map((cell) => inlines(cell.children))) })
          break
        case "thematicBreak":
          out.push({ t: "hr" })
          break
        case "footnoteDefinition":
          out.push({ t: "p", c: [{ t: "text", v: `[${node.label ?? node.identifier ?? ""}] ` }, ...(node.children ?? []).flatMap((child) => inlines(child.children))] })
          break
        case "definition":
          break
        default:
          if (node.children) out.push({ t: "p", c: inlines(node.children) })
          else if (node.value) out.push({ t: "p", c: [{ t: "text", v: node.value }] })
      }
    }
    return out
  }

  const body = blocks(tree.children)
  return {
    label: meta.label,
    ...(meta.title ? { title: meta.title } : {}),
    ...(meta.excerpt ? { excerpt: meta.excerpt } : {}),
    blocks: body,
    ...(truncated ? { truncated: true } : {}),
  }
}
