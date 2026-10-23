/**
 * The readable text of one of the club site's pages, from its HTML, for `read` (design §7.3).
 * Headings become "#" lines (so the outline works), list items "- " lines, and blocks are separated
 * by blank lines. Scripts, styles, SVG and the like are dropped, and only <main> is read when the page
 * has one (the site's header and footer repeat on every page). Not a general HTML parser: it reads
 * our own pages, and its output is only ever text.
 */

const DROP = ["script", "style", "noscript", "template", "svg", "head", "iframe", "object", "canvas", "select", "button"]
const BLOCK = /^(p|div|section|article|aside|header|footer|nav|main|ul|ol|table|thead|tbody|tr|blockquote|figure|figcaption|form|fieldset|dl|dt|dd|pre|hr|address|details|summary)$/

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  times: "×",
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1].toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole
  })
}

/** The page's <title>, decoded and on one line */
export function htmlTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = match ? decodeEntities(match[1]).replace(/\s+/g, " ").trim() : ""
  return title || null
}

/** What's inside the first <main> element, or the whole page when it has none */
function mainOf(html: string): string {
  const open = /<main(?:\s[^>]*)?>/i.exec(html)
  if (!open) return html
  const start = open.index + open[0].length
  const close = html.toLowerCase().lastIndexOf("</main>")
  return close > start ? html.slice(start, close) : html.slice(start)
}

export function htmlToText(html: string): string {
  let body = mainOf(html).replace(/<!--[\s\S]*?-->/g, " ")
  for (const tag of DROP) body = body.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}\\s*>`, "gi"), " ")
  // Void or unclosed leftovers of the dropped tags
  body = body.replace(new RegExp(`<(?:${DROP.join("|")})(?:\\s[^>]*)?/?>`, "gi"), " ")

  const text = body.replace(/<(\/?)([a-z][a-z0-9-]*)((?:\s[^>]*)?)\/?>/gi, (_whole, closing: string, rawName: string) => {
    const name = rawName.toLowerCase()
    const heading = /^h([1-6])$/.exec(name)
    if (heading) return closing ? "\n\n" : `\n\n${"#".repeat(Number(heading[1]))} `
    if (name === "br") return "\n"
    if (name === "li") return closing ? "\n" : "\n- "
    if (name === "td" || name === "th") return closing ? " | " : ""
    if (BLOCK.test(name)) return "\n\n"
    return ""
  })

  return decodeEntities(text.replace(/<[^>]*>/g, ""))
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
    .join("\n")
    .replace(/^(#{1,6}) *\n+(?=\S)/gm, "$1 ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^(- )+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
