import remarkGfm from "remark-gfm"
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

/** One place the text has something MDX would run */
export type MdxProblem = { line: number; what: string; excerpt: string }

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
  const excerpt = (offset: number) => {
    const line = lineOf(offset)
    const from = lineStarts[line]
    const to = line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : text.length
    const start = Math.max(from, offset - 25)
    const end = Math.min(to, offset + 25)
    return `${start > from ? "…" : ""}${text.slice(start, end).trim()}${end < to ? "…" : ""}`
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if ((ch === "<" || ch === "{" || ch === "}") && !inCode(i)) problems.push({ line: lineOf(i) + 1, what: ch, excerpt: excerpt(i) })
  }
  for (const [n, start] of lineStarts.entries()) {
    const match = /^[ \t]*(import|export)\s/.exec(text.slice(start, start + 20))
    if (match && !inCode(start + match[0].indexOf(match[1]))) problems.push({ line: n + 1, what: match[1], excerpt: excerpt(start) })
  }
  return problems.sort((a, b) => a.line - b.line)
}

/** Why `text` can't go in a post, written for the model to fix it, or null when it's plain Markdown */
export function mdxError(text: string, what = "The post's text", tree?: MdNode): string | null {
  const problems = mdxProblems(text, tree)
  if (!problems.length) return null
  const shown = problems
    .slice(0, 3)
    .map((p) => `line ${p.line} has ${p.what === "import" || p.what === "export" ? `a line starting with "${p.what}"` : `"${p.what}"`} (${p.excerpt})`)
    .join("; ")
  const more = problems.length > 3 ? ` and ${problems.length - 3} more` : ""
  return `${what} must be plain Markdown: the site shows it with MDX, where "<" starts a component, "{" and "}" run code, and a line starting with import or export is code. Here ${shown}${more}. Use Markdown instead (**bold**, [text](https://…), - lists), leave out HTML and braces, and put any of these characters inside \`code\` if they must show.`
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
