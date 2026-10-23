import { formatInTimeZone } from "date-fns-tz"
import { z } from "zod"
import type { JackLinkItem } from "@/lib/jack/parts"
import { findPassages, fitToCap, outlineOf, pageOf, READ_DEFAULT_CHARS, READ_MAX_CHARS } from "@/server/jack/search/paging"
import { findReader, SEARCH_READERS, SEARCH_SOURCES } from "@/server/jack/search/registry"
import { search, type SourceOutcome } from "@/server/jack/search/search"
import type { SearchHit } from "@/server/jack/search/types"
import { forModel, forModelWithList, MAX_MODEL_CHARS, plural } from "./display"
import { CLUB_TZ, ct } from "./time"
import type { JackTool } from "./types"

/**
 * search and read (#188, design §7.1 and §7.3): one search over every source the tracks register
 * (search/registry.ts), and a reader for whatever it finds, a page at a time.
 */

const SOURCE_KEYS = SEARCH_SOURCES.map((source) => source.key) as [string, ...string[]]
const READ_TYPES = SEARCH_READERS.map((reader) => reader.type) as [string, ...string[]]

/** "Oct 19, 2026" for the room */
function shortDate(iso: string | null): string | null {
  return iso ? formatInTimeZone(new Date(iso), CLUB_TZ, "MMM d, yyyy") : null
}

/** A hit as the model reads it: what to pass to read, where it links, when, and what matched */
export function hitForModel(hit: SearchHit) {
  return {
    type: hit.type,
    id: hit.id,
    title: hit.title,
    url: hit.url,
    ...(hit.date ? { date: ct(new Date(hit.date)) } : {}),
    ...(hit.snippet ? { snippet: hit.snippet } : {}),
    ...hit.meta,
  }
}

/** What a hit is, for the room, when its source doesn't say (the site's hits name their kind, documents where they're from) */
const SOURCE_LABEL: Record<string, string> = { knowledge: "Knowledge", documents: "Document", rooms: "Room message", site: "Site", teams: "Teams" }

export function hitLink(hit: SearchHit): JackLinkItem {
  const kind = typeof hit.meta.kind === "string" ? hit.meta.kind : typeof hit.meta.in === "string" ? hit.meta.in : (SOURCE_LABEL[hit.source] ?? hit.source)
  return { title: hit.title, url: hit.url, meta: [kind, shortDate(hit.date)].filter(Boolean).join(" · "), snippet: hit.snippet || undefined }
}

/**
 * Sources that weren't searched, for the model and the room: "teams: Teams isn't connected…". One
 * that failed always says so; one that's switched off only when the call named it, since Teams can
 * stay off for months and every default search would mention it
 */
function skipped(outcomes: SourceOutcome[], named: string[] | undefined): string[] {
  return outcomes.flatMap((outcome) =>
    outcome.status === "searched" || (outcome.status === "unavailable" && !named?.includes(outcome.source)) ? [] : [`${outcome.source}: ${outcome.reason}`],
  )
}

const searchInput = z.object({
  query: z
    .string()
    .trim()
    .min(1, "Say what to search for")
    .max(200)
    .describe('What to look for: a few distinctive words, "a phrase in quotes", or between alternatives, -word to leave one out. Matches whole words (and their endings), not parts of words'),
  sources: z
    .array(z.enum(SOURCE_KEYS))
    .min(1)
    .max(SOURCE_KEYS.length)
    .optional()
    .describe(`Only these sources (default: all of them). ${SEARCH_SOURCES.map((source) => `${source.key}: ${source.description}`).join("; ")}`),
  includeJackReplies: z
    .boolean()
    .default(false)
    .describe("Also search your own earlier answers in rooms. They aren't sources: check anything in one against the data before repeating it"),
  limit: z.number().int().min(1).max(25).default(10).describe("How many results to return, best first"),
})

export const searchTool: JackTool<z.infer<typeof searchInput>> = {
  name: "search",
  description:
    "Full-text search across the club's records: knowledge entries, Drive and SharePoint documents, what officers wrote in Jack rooms (and the rooms' notes), the public site (news, pages, events, gallery, Instagram) and Teams messages. Use it for decisions, how-tos, past discussions, documents and anything the club wrote down, before saying there's no record. Returns the best matches from every source with a link, date and the passage that matched; open one with read (its type and id) to see all of it. Cite results by their link.",
  input: searchInput,
  async run({ query, sources, includeJackReplies, limit }, ctx) {
    const { hits, outcomes } = await search({ query, sources, limit, includeJackReplies, replyId: ctx.messageId, signal: ctx.signal })
    const notSearched = skipped(outcomes, sources)
    const rows = hits.map(hitForModel)
    const base = {
      query,
      searched: outcomes.filter((o) => o.status === "searched").map((o) => o.source),
      ...(notSearched.length ? { notSearched } : {}),
      ...(hits.length ? {} : { note: "Nothing matched. Try other or fewer words (search matches whole words), or another source." }),
    }
    return {
      forModel: forModelWithList(base, "results", rows),
      label: `Searched for “${query}” (${plural(hits.length, "result")})`,
      displays: [
        hits.length
          ? { kind: "links", items: hits.map(hitLink), caption: notSearched.length ? `Not searched: ${notSearched.join(" ")}` : undefined }
          : { kind: "note", text: `Nothing matched “${query}”.${notSearched.length ? ` Not searched: ${notSearched.join(" ")}` : ""}` },
      ],
    }
  },
}

const readInput = z.object({
  type: z.enum(READ_TYPES).describe(`What to read: the type a search result gave. ${SEARCH_READERS.map((reader) => `${reader.type}: ${reader.description}`).join("; ")}`),
  id: z.string().trim().min(1).max(300).describe("The search result's id; for site_page, a path on the club site"),
  offset: z.number().int().min(0).default(0).describe("Where to start, in characters: 0, or the nextOffset a previous read returned"),
  maxChars: z.number().int().min(500).max(READ_MAX_CHARS).default(READ_DEFAULT_CHARS).describe("The most characters to return"),
  query: z.string().trim().min(1).max(200).optional().describe("Return only the passages that match these words, instead of a page from offset"),
})

export const readTool: JackTool<z.infer<typeof readInput>> = {
  name: "read",
  description:
    "Opens one thing search found, by its type and id: a knowledge entry, a document's text, a room message with the messages around it, a news post, page, event, gallery album, Instagram post or Teams thread. Also reads any public page of the club site by its path (type site_page, e.g. /lone-star-cup), never the admin console. Long texts come a page at a time: the result gives total, nextOffset (read again from there) and an outline of its headings; or pass query to get just the passages that match.",
  input: readInput,
  async run({ type, id, offset, maxChars, query }, ctx) {
    const reader = findReader(type)
    if (!reader) return { isError: true, forModel: `Unknown type ${type}. Types: ${READ_TYPES.join(", ")}.`, label: "Couldn't read that", displays: [] }
    const result = await reader.read(id, { signal: ctx.signal })
    if (!result.ok) return { isError: true, forModel: result.error, label: `Couldn't read that ${type.replace("_", " ")}`, displays: [] }

    const { doc } = result
    const head = { type: doc.type, id: doc.id, title: doc.title, url: doc.url, ...(doc.date ? { date: ct(new Date(doc.date)) } : {}), ...doc.meta, total: doc.text.length }
    const link: JackLinkItem = { title: doc.title, url: doc.url, meta: [shortDate(doc.date), `${doc.text.length.toLocaleString("en-US")} characters`].filter(Boolean).join(" · ") }

    // Either way the text is as much as fits with the rest of the result in MAX_MODEL_CHARS, so the
    // result is never cut short after nextOffset was worked out
    if (query) {
      const { match, json } = fitToCap(maxChars, MAX_MODEL_CHARS, (budget) => {
        const match = findPassages(doc.text, query, budget)
        const json = forModel({
          ...head,
          query,
          matched: match.matched,
          passages: match.passages,
          ...(match.matched ? {} : { note: "No passage matches those words. Read it from offset 0 instead, or try other words." }),
          ...(match.matched > match.passages.length ? { note: `Only the best ${match.passages.length} of ${match.matched} matching passages fit.` } : {}),
        })
        return { match, json, used: match.passages.reduce((n, passage) => n + passage.text.length, 0) }
      })
      return {
        forModel: json,
        label: `Read “${doc.title}” (${plural(match.matched, "matching passage")})`,
        displays: [{ kind: "links", items: [link] }],
      }
    }

    const outline = outlineOf(doc.text)
    const { page, paged, json } = fitToCap(maxChars, MAX_MODEL_CHARS, (budget) => {
      const page = pageOf(doc.text, offset, budget)
      const paged = page.nextOffset !== null || page.offset > 0
      const json = forModel({
        ...head,
        offset: page.offset,
        nextOffset: page.nextOffset,
        ...(paged ? { outline } : {}),
        ...(page.offset >= page.total && page.total > 0 ? { note: `That's past the end: the text is ${page.total} characters long.` } : {}),
        text: page.text,
      })
      return { page, paged, json, used: page.text.length }
    })
    return {
      forModel: json,
      label: paged
        ? `Read “${doc.title}” (characters ${(page.offset + 1).toLocaleString("en-US")}–${(page.offset + page.text.length).toLocaleString("en-US")} of ${page.total.toLocaleString("en-US")})`
        : `Read “${doc.title}”`,
      displays: [{ kind: "links", items: [link] }],
    }
  },
}
