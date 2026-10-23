import { PAGE_PUBLIC_PATHS } from "@/app/admin/pages/_components/public-paths"

/** Where search results link to. Console paths for officer-only things, site paths for public ones */

/** A message in a room, opened with the messages around it (the room page reads ?m=) */
export function roomMessageHref(roomId: string, messageId: string): string {
  return `/admin/jack/${roomId}?m=${messageId}`
}

/** A knowledge entry on the Knowledge page (memory track) */
export function knowledgeHref(entryId: string): string {
  return `/admin/knowledge?entry=${entryId}`
}

export function postHref(slug: string): string {
  return `/news/${encodeURIComponent(slug)}`
}

export function eventHref(slug: string): string {
  return `/events/${encodeURIComponent(slug)}`
}

export function albumHref(slug: string): string {
  return `/gallery?album=${encodeURIComponent(slug)}`
}

/** A content page's public path, or null when the site doesn't show it anywhere */
export function pageHref(slug: string): string | null {
  return PAGE_PUBLIC_PATHS[slug] ?? null
}

/** The content pages the site shows (the rest aren't linked anywhere, so they aren't public) */
export const PUBLIC_PAGE_SLUGS = Object.keys(PAGE_PUBLIC_PATHS)

/** A Teams channel message, opened in Teams */
export function teamsMessageHref(message: { id: string; channelId: string; replyToId: string | null }, teamId: string | null): string {
  const params = new URLSearchParams()
  if (teamId) params.set("groupId", teamId)
  params.set("parentMessageId", message.replyToId ?? message.id)
  return `https://teams.microsoft.com/l/message/${encodeURIComponent(message.channelId)}/${encodeURIComponent(message.id)}?${params}`
}

/** An Instagram link, only when it really is one (permalinks come from Instagram's API) */
export function instagramHref(permalink: string): string | null {
  try {
    const url = new URL(permalink)
    return url.protocol === "https:" && /(^|\.)instagram\.com$/i.test(url.hostname) ? url.href : null
  } catch {
    return null
  }
}
