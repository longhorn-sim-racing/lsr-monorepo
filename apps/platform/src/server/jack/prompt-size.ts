import type { BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { SLOT_TRACKS, type SlotTrack } from "@/lib/slots"
import { JACK_ROOM_PERSONAS, type JackRoomPersonaKey } from "@/lib/jack/types"
import { requestTools, toolDefinitions } from "./model-loop"
import { buildSystemPrompt } from "./prompt"
import { PROMPT_SLOTS } from "./prompt-sections"
import { KIND_SLOTS } from "./proposals/registry"
import { PROPOSE_TOOLS, type AnyProposalKind } from "./proposals/types"
import { CORE_JACK_TOOLS, JACK_TOOLS } from "./tools"
import { proposeTool } from "./tools/propose"
import { TOOL_SLOTS } from "./tools/registry"
import type { AnyJackTool } from "./tools/types"
import { TOOL_SEARCH_TOOL } from "./web-tools"

/**
 * How big Jack's cached prefix is (design §8), in characters: the system prompt (the core rules with
 * every track's section and page lines, then the notes on the database) and the definitions of the
 * tools every request loads, as the request sends them. A deferred tool (tool search) is sent too but
 * stays out of the model's context until it's found, so it's counted apart. prompt-size.test.ts holds
 * the budgets; `pnpm --filter @lsr/platform exec tsx scripts/jack-prompt-size.ts` prints the table.
 *
 * Server tools (tool search, web search and fetch) count as the JSON we send; the API adds its own
 * instructions for them, which can't be measured here.
 */

/** What one track adds */
export type TrackSize = {
  track: SlotTrack
  /** Its prompt section and its page lines (in every request) */
  section: number
  pages: number
  /** Its own tools: loaded in every request, or behind tool search */
  tools: number
  deferredTools: number
  /** What its proposal kinds add to the propose_* tools, always loaded or deferred (a tool only its kinds use counts whole) */
  kinds: number
  deferredKinds: number
}

/**
 * The most the cached prefix may hold, web tools on (about 28,500 tokens). It was 84,000 characters with
 * wave 2a merged (10/23); wave 2b adds three prompt sections. Moving rarely used tools behind tool
 * search is the way down (design §7.1); raise this only on purpose.
 */
export const PREFIX_MAX_CHARS = 100_000

/**
 * Each track's budget (design §8), in characters as the request sends them: `loaded` is its section,
 * page lines, always-loaded tools and what its kinds add to always-loaded propose_* tools; `deferred` is
 * its tools and kinds behind tool search. A track over budget trims its section (table detail goes to
 * schema notes), shortens descriptions, or defers a rarely used tool; raising a budget is a decision for
 * its PR. Some tracks' own tests hold tighter budgets on part of this (changes/kinds.test.ts,
 * tools/registry/*.test.ts). The wave 2b tracks (discord-post, decks-rooms' publishing, automation) get
 * room for a section and their deferred propose_* tools.
 */
export const TRACK_BUDGETS: Record<SlotTrack, { loaded: number; deferred: number }> = {
  groundwork: { loaded: 6_000, deferred: 2_000 },
  "club-data": { loaded: 7_000, deferred: 6_000 },
  memory: { loaded: 5_500, deferred: 2_000 },
  changes: { loaded: 18_000, deferred: 2_000 },
  "sources-a": { loaded: 2_500, deferred: 9_000 },
  "sources-b": { loaded: 2_500, deferred: 6_000 },
  documents: { loaded: 2_500, deferred: 2_000 },
  "discord-read": { loaded: 2_500, deferred: 4_000 },
  "discord-post": { loaded: 3_000, deferred: 15_000 },
  "decks-rooms": { loaded: 3_000, deferred: 10_000 },
  "sponsors-meetings": { loaded: 5_500, deferred: 12_000 },
  automation: { loaded: 3_000, deferred: 6_000 },
}

/** What a track puts in every request (the cached prefix) */
export const loadedSize = (t: TrackSize) => t.section + t.pages + t.tools + t.kinds
/** What a track sends behind tool search (in context only once found) */
export const deferredSize = (t: TrackSize) => t.deferredTools + t.deferredKinds

export type PromptSize = {
  /** The whole system prompt, per persona */
  system: Record<JackRoomPersonaKey, number>
  /** Of that, the notes on the database */
  schemaNotes: number
  /** Definitions in every request: the core tools, the tracks' always-loaded tools and propose_* tools, and the tool search tool */
  tools: number
  /** Definitions sent with defer_loading, found through tool search (web tools off) */
  deferredTools: number
  /** What the web tools add (JACK_WEB_TOOLS=on): web search and fetch; web_links is deferred */
  webTools: number
  /** The cached prefix: the largest persona's system prompt and the always-loaded definitions, web tools off and on */
  prefix: { noWeb: number; web: number }
  /** The tools Jack had before 2.0 */
  coreTools: number
  /**
   * What no one track owns, each part measured on its own (not as what's left of `tools`): the tool search
   * tool, sent when any tool is deferred, and what's left of the always-loaded propose_* tools once each
   * track's kinds are taken out (their leads and rules where several tracks' kinds share a tool)
   */
  shared: { toolSearch: number; propose: number }
  tracks: TrackSize[]
}

const chars = (value: unknown) => JSON.stringify(value).length
const defsSize = (defs: BetaToolUnion[]) => defs.reduce((n, def) => n + chars(def), 0)
const toolsSize = (tools: AnyJackTool[]) => defsSize(toolDefinitions(tools))
const isDeferred = (def: BetaToolUnion) => "defer_loading" in def && def.defer_loading === true

/** The propose_* tools as they'd be built from these kinds: always loaded, and deferred */
export function proposeSize(kinds: AnyProposalKind[]): { loaded: number; deferred: number } {
  let loaded = 0
  let deferred = 0
  for (const name of PROPOSE_TOOLS) {
    const tool = proposeTool(
      name,
      kinds.filter((kind) => kind.tool === name),
    )
    if (!tool) continue
    if (tool.deferred) deferred += toolsSize([tool])
    else loaded += toolsSize([tool])
  }
  return { loaded, deferred }
}

export function measurePrompt(): PromptSize {
  const system = Object.fromEntries(JACK_ROOM_PERSONAS.map((persona) => [persona, buildSystemPrompt(persona).reduce((n, block) => n + block.text.length, 0)])) as Record<JackRoomPersonaKey, number>
  const [, notes] = buildSystemPrompt("jack")

  const offDefs = requestTools(JACK_TOOLS, { web: false }).defs
  const onDefs = requestTools(JACK_TOOLS, { web: true }).defs
  const tools = defsSize(offDefs.filter((def) => !isDeferred(def)))
  const webLoaded = defsSize(onDefs.filter((def) => !isDeferred(def)))
  const biggest = Math.max(...Object.values(system))

  const allKinds = SLOT_TRACKS.flatMap((track) => KIND_SLOTS[track])
  const withAll = proposeSize(allKinds)
  const tracks = SLOT_TRACKS.map((track): TrackSize => {
    const slot = PROMPT_SLOTS[track]
    const section = slot.section.trim()
    const own = TOOL_SLOTS[track].filter((tool) => !(PROPOSE_TOOLS as readonly string[]).includes(tool.name))
    const without = proposeSize(allKinds.filter((kind) => !KIND_SLOTS[track].includes(kind)))
    return {
      track,
      // Sections are joined by a blank line, page lines start with "- " and end with a newline
      section: section ? section.length + 2 : 0,
      pages: slot.pages.reduce((n, page) => n + page.trim().length + 3, 0),
      tools: toolsSize(own.filter((tool) => !tool.deferred && !tool.web)),
      deferredTools: toolsSize(own.filter((tool) => tool.deferred || tool.web)),
      kinds: withAll.loaded - without.loaded,
      deferredKinds: withAll.deferred - without.deferred,
    }
  })
  const deferredTools = defsSize(offDefs.filter(isDeferred))

  return {
    system,
    schemaNotes: notes?.text.length ?? 0,
    tools,
    deferredTools,
    webTools: webLoaded - tools,
    prefix: { noWeb: biggest + tools, web: biggest + webLoaded },
    coreTools: toolsSize(CORE_JACK_TOOLS),
    shared: {
      toolSearch: deferredTools > 0 ? chars(TOOL_SEARCH_TOOL) : 0,
      propose: withAll.loaded - tracks.reduce((n, t) => n + t.kinds, 0),
    },
    tracks,
  }
}
