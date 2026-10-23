/**
 * A Teams message body as plain text (design §3.3: TeamsMessage.content is "HTML stripped"). Teams sends
 * HTML: paragraphs and line breaks become new lines, mentions become "@Name", links keep their text
 * with the address after it, emoji keep their character, images and attachments become a short note.
 * Nothing here is ever rendered as HTML; it's stored, searched and shown as text.
 */

/** The longest text kept per message (the search index reads up to 100k) */
export const TEAMS_TEXT_MAX_CHARS = 20_000

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

const attribute = (tag: string, name: string) => {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)
  return match ? decodeEntities(match[2] ?? match[3] ?? match[4] ?? "") : null
}

/** Block elements: a line break before and after */
const BLOCK = new Set(["p", "div", "li", "ul", "ol", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "table", "tr"])

export function teamsText(content: string | null | undefined, contentType: string = "html"): string {
  if (!content) return ""
  if (contentType.toLowerCase() === "text") return capped(content.replace(/\r\n?/g, "\n").trim())
  let out = ""
  let link: { href: string | null; text: string } | null = null
  const push = (text: string) => {
    if (link) link.text += text
    else out += text
  }
  // Linear on any input: the tag name is taken whole and a tag never runs past the next "<"
  for (const [whole, closing, rawTag, text] of content.matchAll(/<(\/?)([a-zA-Z][\w:-]*)(?![\w:-])[^<>]*>|([^<]+)|</g)) {
    if (text !== undefined) {
      push(decodeEntities(text).replace(/\s+/g, " "))
      continue
    }
    if (!rawTag) {
      // A stray "<" that isn't a tag
      push("<")
      continue
    }
    const tag = rawTag.toLowerCase()
    if (tag === "br") push("\n")
    else if (tag === "li") {
      if (!closing) push("\n- ")
    } else if (BLOCK.has(tag)) push("\n")
    else if (tag === "td" || tag === "th") {
      if (closing) push(" | ")
    } else if (tag === "at" && !closing) push("@")
    else if (tag === "emoji" && !closing) push(attribute(whole, "alt") ?? "")
    else if (tag === "img" && !closing) push(attribute(whole, "alt") ? `(image: ${attribute(whole, "alt")})` : "(image)")
    else if (tag === "attachment" && !closing) push("(attachment)")
    else if (tag === "a") {
      if (!closing) link = { href: attribute(whole, "href"), text: "" }
      else if (link) {
        const { href, text: label } = link
        link = null
        const shown = label.trim()
        // The address goes after the text, so a link reads the same as plain text and search finds its host
        out += href && /^https?:\/\//i.test(href) && href !== shown ? `${shown}${shown ? " " : ""}(${href})` : shown
      }
    }
  }
  if (link) out += link.text
  return capped(
    out
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  )
}

/** At most TEAMS_TEXT_MAX_CHARS, and no NUL characters (Postgres text can't hold them) */
function capped(raw: string): string {
  const text = raw.replace(/\u0000/g, "")
  return text.length > TEAMS_TEXT_MAX_CHARS ? `${text.slice(0, TEAMS_TEXT_MAX_CHARS - 1)}…` : text
}
