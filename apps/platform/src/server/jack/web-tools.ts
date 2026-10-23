import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaServerToolUseBlock,
  BetaServerToolUseBlockParam,
  BetaToolSearchToolBm25_20251119,
  BetaWebFetchTool20260209,
  BetaWebSearchTool20260209,
} from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { linkHost } from "@/lib/jack/links"
import type { JackToolDisplay, JackToolPart, JackWebSourcesDisplay } from "@/lib/jack/parts"

/**
 * Jack's server tools (#188, design §7.2 and §7.4): web search, web fetch and tool search. They run on
 * Anthropic's side, inside an API call: their calls and results arrive as blocks in the response, which
 * the model loop sends back unchanged and shows as parts (web search and fetch only; tool search is
 * plumbing).
 */

export const WEB_SEARCH = "web_search"
export const WEB_FETCH = "web_fetch"
export const TOOL_SEARCH = "tool_search_tool_bm25"
/** The one client tool whose results web_fetch may follow (tools/web-links.ts): it only returns earlier search and fetch results */
export const WEB_LINKS = "web_links"

/** Names the API gives its server tools. No Jack tool may take one (the request would be rejected) */
export const SERVER_TOOL_NAMES: ReadonlySet<string> = new Set([
  WEB_SEARCH,
  WEB_FETCH,
  TOOL_SEARCH,
  "tool_search_tool_regex",
  "code_execution",
  "bash_code_execution",
  "text_editor_code_execution",
  "advisor",
])

/**
 * JACK_WEB_TOOLS=on gives room replies web search and fetch. The Anthropic Console must allow both
 * too, or every request that includes them is rejected (400)
 */
export function webToolsOn(): boolean {
  return process.env.JACK_WEB_TOOLS?.trim().toLowerCase() === "on"
}

/** Per API call; a reply makes one call per tool round, and REPLY_LIMITS caps the whole reply */
export const WEB_LIMITS = {
  searchMaxUses: 5,
  fetchMaxUses: 3,
  /** About how much of a page's text one fetch adds to the conversation, in tokens (PDFs aren't capped by it) */
  fetchMaxContentTokens: 10_000,
}

/** Added to a request when any of its tools is deferred; never deferred itself */
export const TOOL_SEARCH_TOOL: BetaToolSearchToolBm25_20251119 = { type: "tool_search_tool_bm25_20251119", name: TOOL_SEARCH }

/**
 * Web search and fetch as a request sends them, given the names of the client tools in it.
 *
 * web_fetch only opens links from officers' messages, from earlier search and fetch results, and from
 * web_links (which only returns those). Every other client tool's results are excluded, so a link inside
 * club data, a document or a message can never be fetched (design §7.2). Fetched pages don't get
 * citations: a request's documents must all have them or none, and documents in tool results don't
 */
export function webServerTools(clientToolNames: readonly string[]): [BetaWebSearchTool20260209, BetaWebFetchTool20260209] {
  return [
    {
      type: "web_search_20260209",
      name: WEB_SEARCH,
      max_uses: WEB_LIMITS.searchMaxUses,
      user_location: { type: "approximate", city: "Austin", region: "Texas", country: "US", timezone: "America/Chicago" },
    },
    {
      type: "web_fetch_20260209",
      name: WEB_FETCH,
      max_uses: WEB_LIMITS.fetchMaxUses,
      max_content_tokens: WEB_LIMITS.fetchMaxContentTokens,
      url_sources: {
        user_input: { type: "all" },
        server_tool_results: { type: "all" },
        client_tool_results: clientToolNames.includes(WEB_LINKS) ? { type: "only", tools: [{ type: "tool_reference", name: WEB_LINKS }] } : { type: "none" },
      },
    },
  ]
}

type ServerToolUse = BetaServerToolUseBlock | BetaServerToolUseBlockParam
type AnyBlock = BetaContentBlock | BetaContentBlockParam

/** A web search or fetch call (a server_tool_use block) */
export function isWebCall(block: AnyBlock): block is ServerToolUse & { name: typeof WEB_SEARCH | typeof WEB_FETCH } {
  return block.type === "server_tool_use" && (block.name === WEB_SEARCH || block.name === WEB_FETCH)
}

/**
 * Server tool calls in a turn whose results aren't in it. In a turn that also calls Jack's own tools,
 * a web call can still be running: its result comes first in the next response, and until then the
 * next user turn may hold tool results only (any text with them is rejected)
 */
export function pendingServerCalls(content: readonly AnyBlock[]): string[] {
  const answered = new Set<string>()
  for (const block of content) {
    const id = block.type !== "tool_result" && "tool_use_id" in block ? block.tool_use_id : null
    if (typeof id === "string") answered.add(id)
  }
  return content.flatMap((block) => (block.type === "server_tool_use" && !answered.has(block.id) ? [block.id] : []))
}

/** A web search or fetch in a reply, as its part shows it */
export type WebCall = {
  id: string
  name: typeof WEB_SEARCH | typeof WEB_FETCH
  /** `{ query }` or `{ url }`, once the call's input has arrived */
  input: Record<string, unknown> | null
  /** The search's results or the page it read; null until the result arrives */
  found: { url: string; title: string | null }[] | null
  /** The API's error code, when the call failed */
  error: string | null
  startedAt: number
  ms?: number
}

/** Records a web_search_tool_result or web_fetch_tool_result on its call. The content is the API's JSON, so it's read defensively */
export function recordWebResult(call: WebCall, block: AnyBlock, at: number) {
  const content = (block as { content?: unknown }).content
  const errorCode = (value: unknown) => {
    const code = (value as { error_code?: unknown } | null)?.error_code
    return typeof code === "string" ? code : "unknown"
  }
  if (block.type === "web_search_tool_result") {
    if (Array.isArray(content)) {
      call.found = content.flatMap((result: { type?: unknown; url?: unknown; title?: unknown }) =>
        result?.type === "web_search_result" && typeof result.url === "string" ? [{ url: result.url, title: typeof result.title === "string" && result.title ? result.title : null }] : []
      )
      call.error = null
    } else {
      call.found = []
      call.error = errorCode(content)
    }
  } else if (block.type === "web_fetch_tool_result") {
    const page = content as { type?: unknown; url?: unknown; content?: { title?: unknown } } | null
    if (page?.type === "web_fetch_result" && typeof page.url === "string") {
      const title = page.content?.title
      call.found = [{ url: page.url, title: typeof title === "string" && title ? title : null }]
      call.error = null
    } else {
      call.found = []
      call.error = errorCode(content)
    }
  } else return
  call.ms = Math.max(0, at - call.startedAt)
}

/** The web pages a reply's text cites, by URL, with the title the citation gave */
export function addCitations(cited: Map<string, string | null>, content: readonly AnyBlock[]) {
  for (const block of content) {
    if (block.type !== "text" || !Array.isArray(block.citations)) continue
    for (const citation of block.citations) {
      if (citation.type === "web_search_result_location" && typeof citation.url === "string" && !cited.has(citation.url)) {
        cited.set(citation.url, citation.title ?? null)
      }
    }
  }
}

/** Most pages one part lists */
const MAX_SOURCES = 10

/** What the API's error codes mean, for the room */
const WEB_ERRORS: Record<string, string> = {
  too_many_requests: "too many requests right now; try again in a minute",
  max_uses_exceeded: "this answer has used up its searches and pages",
  query_too_long: "the search was too long",
  request_too_large: "the request was too large",
  invalid_tool_input: "the request wasn't valid",
  unavailable: "the service isn't available right now",
  url_too_long: "the link is too long",
  url_not_allowed: "that site isn't allowed",
  url_not_in_prior_context: "only links an officer posted or a web search found can be opened",
  url_not_accessible: "the page couldn't be reached",
  unsupported_content_type: "that kind of file can't be read",
  content_too_large: "the page is too large",
}

export function webErrorText(code: string): string {
  return WEB_ERRORS[code] ?? `error ${code}`
}

type WebPartFields = Pick<JackToolPart, "name" | "label" | "status" | "input" | "displays" | "error" | "ms">

/**
 * Each web call's part, in the order the calls started: label, status, input and a web_sources display.
 * A search lists the results the reply cites (a page cited from several searches shows under the first);
 * a fetch shows the page it read. Citations arrive after the results, so a search's list fills in later
 */
export function webPartFields(calls: Iterable<WebCall>, cited: ReadonlyMap<string, string | null>): Map<string, WebPartFields> {
  const claimed = new Set<string>()
  const out = new Map<string, WebPartFields>()
  for (const call of calls) {
    const base = { name: call.name, input: call.input, ...(call.ms !== undefined ? { ms: call.ms } : {}) }
    const sources = (pages: { url: string; title: string | null }[]): JackWebSourcesDisplay["sources"] =>
      pages.slice(0, MAX_SOURCES).map((page) => ({ title: page.title ?? cited.get(page.url) ?? page.url, url: page.url, host: linkHost(page.url) ?? "" }))

    if (call.name === WEB_SEARCH) {
      const query = typeof call.input?.query === "string" ? call.input.query : null
      const display = (pages: { url: string; title: string | null }[]): JackToolDisplay[] =>
        query || pages.length ? [{ kind: "web_sources", queries: query ? [query] : [], sources: sources(pages) }] : []
      if (!call.found) {
        out.set(call.id, { ...base, label: "Searching the web", status: "running", displays: display([]) })
      } else if (call.error) {
        out.set(call.id, { ...base, label: "Web search failed", status: "error", error: `Web search failed: ${webErrorText(call.error)}`, displays: display([]) })
      } else {
        const used = call.found.filter((page) => cited.has(page.url) && !claimed.has(page.url))
        for (const page of used) claimed.add(page.url)
        const results = call.found.length
        out.set(call.id, {
          ...base,
          label: `Searched the web (${results} ${results === 1 ? "result" : "results"}${used.length ? `, ${used.length} cited` : ""})`,
          status: "done",
          displays: display(used),
        })
      }
      continue
    }

    const url = typeof call.input?.url === "string" ? call.input.url : null
    const host = (url && linkHost(url)) || null
    if (!call.found) {
      out.set(call.id, { ...base, label: `Opening ${host ?? "a web page"}`, status: "running", displays: [] })
    } else if (call.error || !call.found.length) {
      out.set(call.id, {
        ...base,
        label: `Couldn't open ${host ?? "a web page"}`,
        status: "error",
        error: `Couldn't open ${host ?? "the page"}: ${webErrorText(call.error ?? "unknown")}`,
        displays: [],
      })
    } else {
      const page = call.found[0]
      out.set(call.id, {
        ...base,
        label: `Read ${linkHost(page.url) ?? host ?? "a web page"}`,
        status: "done",
        displays: [{ kind: "web_sources", queries: [], sources: sources([page]) }],
      })
    }
  }
  return out
}
