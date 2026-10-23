/**
 * Text the club's bot posts to Discord (design §12.1, §14). A post must never ping anyone or link
 * anywhere an officer didn't ask for, and outside text (a Twitch title) must never format itself into
 * a link or a mention. Pure helpers, shared by the proposal kinds, the standing rules' templates and the
 * Announcements page.
 */

/** Discord's limits on one message (research/discord.md §3 W1 and W2) */
export const DISCORD_LIMITS = {
  content: 2000,
  embeds: 10,
  embedTotal: 6000,
  embedTitle: 256,
  embedDescription: 4096,
  embedFields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  pollQuestion: 300,
  pollAnswers: 10,
  pollAnswer: 55,
  /** A poll's longest duration, in hours (32 days) */
  pollHours: 768,
  nonce: 25,
} as const

/** Mentions Discord turns into pings: @everyone, @here, a user (<@id>, <@!id>) or a role (<@&id>). A channel link (<#id>) pings nobody and stays */
const MENTION = /@(?:everyone|here)\b|<@[!&]?\d{1,25}>/gi

/** A masked link, [label](url), with or without <> around the url, and with or without a "title" (hover text) after it */
const MASKED_LINK = /\[([^\]\n]{0,256})\]\(\s*<?(https?:\/\/[^\s)>]+)>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/gi
/** <url>: a link without its preview */
const ANGLE_LINK = /<(https?:\/\/[^\s>]+)>/gi
/** A bare http(s) link */
const BARE_LINK = /\bhttps?:\/\/[^\s<>]+/gi
/** A Discord invite, with or without https:// in front: Discord shows an invite card for either. The code is case-sensitive */
const INVITE = /\b(?:discord(?:app)?\.com\/invite|discord\.gg)\/([\w-]+)/gi

/** An invite's code, when a link is one */
function inviteCode(link: string): string | null {
  return link.match(/\b(?:discord(?:app)?\.com\/invite|discord\.gg)\/([\w-]+)/i)?.[1] ?? null
}

/** An invite as one link, however it was written */
const inviteLink = (code: string) => `https://discord.gg/${code}`

/** Punctuation that ends a sentence rather than a bare link ("see https://x.org/a."), and an unmatched ")" */
function trimLink(url: string): string {
  let out = url.replace(/[.,;:!?'"]+$/, "")
  while (out.endsWith(")") && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) out = out.slice(0, -1)
  return out
}

/** A link's host, lowercased without "www.", or null when it isn't an http(s) link */
export function linkHost(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null
    return parsed.hostname.toLowerCase().replace(/^www\./, "") || null
  } catch {
    return null
  }
}

/** The same link written two ways ("https://WWW.x.org/a/" and "https://x.org/a") compares equal */
function linkKey(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname.toLowerCase().replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}${parsed.hash}`
  } catch {
    return url.toLowerCase()
  }
}

/** The mentions in a text that would ping, as written ("@everyone", "<@&123>") */
export function mentionsIn(text: string): string[] {
  return [...text.matchAll(MENTION)].map((m) => m[0])
}

/** The links in a text: masked, <angle> and bare http(s) links, and Discord invites written without https:// (as https://discord.gg/<code>) */
export function linksIn(text: string): string[] {
  const links: string[] = []
  const rest = text
    .replace(MASKED_LINK, (_, __, url: string) => {
      links.push(trimLink(url))
      return " "
    })
    .replace(ANGLE_LINK, (_, url: string) => {
      links.push(url)
      return " "
    })
    .replace(BARE_LINK, (m) => {
      const url = trimLink(m)
      links.push(url)
      return ` ${m.slice(url.length)}`
    })
  for (const m of rest.matchAll(INVITE)) links.push(inviteLink(m[1]))
  return links
}

/** Spaces and blank lines tidied after something was taken out; line breaks the writer meant stay */
export function tidy(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    // "Monday !" where a mention came out before the "!"
    .replace(/ +([!?.,;:])(?=\s|$)/g, "$1")
    .replace(/ +\n/g, "\n")
    .replace(/\n +/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** Takes out every mention that would ping: "@everyone" becomes "everyone", a user or role mention goes */
export function stripMentions(text: string): string {
  return text.replace(MENTION, (m) => (m.startsWith("@") ? m.slice(1) : ""))
}

/** Takes out every link: a masked link keeps its words, any other link (an invite without https:// too) goes */
export function stripLinks(text: string): string {
  return text
    .replace(MASKED_LINK, (_, label: string) => label)
    .replace(ANGLE_LINK, "")
    .replace(BARE_LINK, (m) => m.slice(trimLink(m).length))
    .replace(INVITE, "")
}

/**
 * Escapes Discord's Markdown, so a value shows as written: no bold, masked links, spoilers, code, quotes,
 * headings or lists, and no <@…>, <#…> or <t:…> tokens. Discord drops the backslash before punctuation
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/[\\*_~`|<>[\]]/g, "\\$&")
    .replace(/^([#\-+])/gm, "\\$1")
    .replace(/^(\d+)\./gm, "$1\\.")
}

/** Cuts text to `max` characters, ending in "…" when it was longer */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/**
 * A value from our data or an outside service (an event's title, a venue, a driver's name, a Twitch
 * title) as a template puts it in a post: one line, no mentions, no links, no Markdown, at most `max`
 * characters. Templates add their own links
 */
export function templateValue(text: string | null | undefined, max = 200): string {
  const plain = tidy(stripLinks(stripMentions(text ?? "")).replace(/\s+/g, " "))
  return escapeMarkdown(clipText(plain, max))
}

export type CleanedText = {
  text: string
  /** What came out, as written: pings and links no officer's message in the room had */
  removed: { mentions: string[]; links: string[] }
}

/** Stands in for a link that stays while the rest of the text is checked; the text never holds these characters (they're taken out first) */
const HELD = /\uE000(\d+)\uE001/g
/** A bare http(s) link in text that may hold stand-ins (they end it) */
const BARE_HELD = /\bhttps?:\/\/[^\s<>\uE000\uE001]+/gi

/**
 * A post's text as Jack wrote it, checked against what officers wrote in the room (design §12.1): a
 * mention stays only when an officer's own message has the same one, a link stays when it points at the
 * club's site or an officer's message has it, and a Discord invite only when an officer's message has
 * it. Everything else comes out (a masked link keeps its words). Links that stay are set aside while the
 * rest is checked, so the bare-link pass skips exactly those, never text that only looks like a masked
 * link. The Discord-side guard is separate: a post pings nobody unless it names a ping
 * (allowed_mentions), whatever its text says.
 */
export function cleanPostText(text: string, { officerTexts, siteHosts }: { officerTexts: string[]; siteHosts: string[] }): CleanedText {
  const removed: CleanedText["removed"] = { mentions: [], links: [] }
  const officer = officerTexts.join("\n")
  const officerLower = officer.toLowerCase()
  const officerLinks = new Set(linksIn(officer).map(linkKey))
  const officerInvites = new Set([...officer.matchAll(INVITE)].map((m) => m[1]))
  const ours = (url: string) => {
    const host = linkHost(url)
    return host !== null && siteHosts.some((site) => host === site || host.endsWith(`.${site}`))
  }
  const keepLink = (url: string) => {
    const code = inviteCode(url)
    return code ? officerInvites.has(code) : ours(url) || officerLinks.has(linkKey(url))
  }
  const held: string[] = []
  const hold = (kept: string) => `\uE000${held.push(kept) - 1}\uE001`
  const restore = (part: string) => part.replace(HELD, (_, i: string) => held[Number(i)] ?? "")
  /** Bare links and invites: the ones that stay set aside, the rest taken out */
  const checkBare = (part: string) =>
    part
      .replace(BARE_HELD, (m) => {
        const url = trimLink(m)
        if (keepLink(url)) return hold(url) + m.slice(url.length)
        removed.links.push(url)
        return m.slice(url.length)
      })
      .replace(INVITE, (m, code: string) => {
        if (officerInvites.has(code)) return hold(m)
        removed.links.push(inviteLink(code))
        return ""
      })

  let out = text.replace(/[\uE000\uE001]/g, "")
  out = out.replace(MENTION, (m) => {
    if (officerLower.includes(m.toLowerCase())) return m
    removed.mentions.push(m)
    return m.startsWith("@") ? m.slice(1) : ""
  })
  out = out.replace(MASKED_LINK, (whole, label: string, url: string) => {
    // A kept link's words are checked too, so they can't carry a link of their own
    if (keepLink(trimLink(url))) return hold(`[${restore(checkBare(label))}]${whole.slice(label.length + 2)}`)
    removed.links.push(trimLink(url))
    return label
  })
  out = out.replace(ANGLE_LINK, (whole, url: string) => {
    if (keepLink(url)) return hold(whole)
    removed.links.push(url)
    return ""
  })
  return { text: tidy(restore(checkBare(out))), removed }
}

/** The hosts that count as the club's own site: the canonical address and this deployment's */
export function siteHostsOf(...urls: (string | null | undefined)[]): string[] {
  return [...new Set(urls.map((url) => (url ? linkHost(url) : null)).filter((host): host is string => Boolean(host)))]
}
