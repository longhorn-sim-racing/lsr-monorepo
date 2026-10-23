import { z } from "zod"
import { linkHost } from "@/lib/jack/links"
import { parseToolParts } from "@/lib/jack/parts"
import { prisma } from "@/server/db"
import { WEB_FETCH, WEB_LINKS, WEB_SEARCH } from "../web-tools"
import { forModelWithList, plural } from "./display"
import { ct } from "./time"
import type { JackTool } from "./types"

/**
 * web_links (#188, design §7.1): the links earlier replies in this room found on the web. Earlier
 * replies come back as text, without their search results, so web_fetch can't open a page they found
 * ("open the second link") until this puts its link back in the conversation. It reads only the parts
 * the model loop built from web search and fetch results, so it never hands web_fetch a link from club
 * data, which is why web_fetch may follow its results (and no other client tool's)
 */

const input = z.object({
  replies: z.number().int().min(1).max(10).default(3).describe("How many of the room's latest replies that used the web to look through, newest first"),
  match: z.string().trim().max(100).optional().describe("Only links whose title or address contains this text"),
})

/** A reply's toolCalls hold the parts; a web search or fetch part is named after its server tool */
const USED_THE_WEB = [WEB_SEARCH, WEB_FETCH].map((name) => ({ toolCalls: { array_contains: [{ name }] } }))

export const webLinksTool: JackTool<z.infer<typeof input>> = {
  name: WEB_LINKS,
  description:
    "Web links from earlier replies in this room: the pages their web searches cited and the pages they opened, numbered per reply in the order the room shows them, newest reply first. Use it to open a page an earlier reply found (\"open the second link\"): web_fetch can only open a link that's in the conversation, and earlier replies' links aren't until this returns them.",
  input,
  deferred: true,
  web: true,
  async run({ replies, match }, ctx) {
    const rows = await prisma.jackMessage.findMany({
      where: { roomId: ctx.roomId, kind: "assistant", OR: USED_THE_WEB },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: replies,
      select: { createdAt: true, toolCalls: true },
    })
    const needle = match?.toLowerCase()

    const found = rows.flatMap((row) => {
      const parts = parseToolParts(row.toolCalls).filter((part) => part.name === WEB_SEARCH || part.name === WEB_FETCH)
      const searched: string[] = []
      const links: { n: number; title: string; url: string }[] = []
      for (const part of parts) {
        const query = (part.input as { query?: unknown } | null)?.query
        if (part.name === WEB_SEARCH && typeof query === "string") searched.push(query)
        for (const display of Array.isArray(part.displays) ? part.displays : []) {
          if (display.kind !== "web_sources" || !Array.isArray(display.sources)) continue
          for (const source of display.sources) {
            if (typeof source?.url !== "string" || linkHost(source.url) === null || links.some((link) => link.url === source.url)) continue
            links.push({ n: links.length + 1, title: typeof source.title === "string" && source.title ? source.title : source.url, url: source.url })
          }
        }
      }
      // Numbered before filtering, so "the second link" keeps its number
      const shown = needle ? links.filter((link) => link.title.toLowerCase().includes(needle) || link.url.toLowerCase().includes(needle)) : links
      return shown.length ? [{ reply: ct(row.createdAt), searched, links: shown }] : []
    })

    const total = found.reduce((sum, reply) => sum + reply.links.length, 0)
    if (!total) {
      return {
        forModel: !rows.length
          ? "No reply in this room has used the web yet."
          : `No ${match ? `links matching "${match}"` : "web links"} in this room's last ${plural(rows.length, "reply", "replies")} that used the web.`,
        label: "No earlier web links",
        displays: [],
      }
    }
    return {
      forModel: forModelWithList({ note: "Each reply's links are numbered as the room shows them. Open one with web_fetch, by its exact url." }, "replies", found),
      label: `Found ${plural(total, "earlier web link")}`,
      displays: [],
    }
  },
}
