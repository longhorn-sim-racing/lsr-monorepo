import type { JackToolPart } from "./parts"
import { ROOM_LOCK_STALE_MS } from "./timing"
import type { JackMessageView, JackProposalState, JackProposalStatusKey, JackRoomEvent, JackRoomView } from "./types"

/**
 * A room's messages as one viewer sees them, built from a snapshot (the database) plus the live
 * events on the room's channel. Pure, so the page and the tests share it.
 *
 * Streaming replies arrive as numbered deltas. The database saves a reply about once a second, so
 * a snapshot can trail the live stream: a viewer who opens a room mid-answer starts from the
 * snapshot and applies only the deltas after its `streamSeq`. A delta that skips ahead is held
 * until the missing ones turn up or a newer snapshot covers them; meanwhile `needsResync` asks the
 * page for one. A delta marked `replace` carries the whole text so far (the server took some back)
 * and swaps it in, in seq order like any other. The done event carries the whole reply, so a reply
 * always ends complete; when it was too big for Realtime it comes `trimmed` (no tool displays, maybe
 * no text), the reply keeps what it has, and `needsResync` stays on until a snapshot brings the rest.
 *
 * Tool calls arrive as parts, each replacing the part with the same id. They aren't numbered, so a
 * part never goes back from finished (done or error) to running, and a snapshot's parts merge with
 * the live ones rather than replacing them. A part for a message not seen yet is held like a delta.
 *
 * The room's own settings (its persona) come the same two ways; the newer copy wins.
 *
 * Proposals' live statuses (#188) come from `proposal.updated` events and, once G4 sends them, from
 * snapshots. A status only moves forward (pending, then applying, then a final one), so a late or
 * stale copy never takes a proposal back.
 */
/** A delta held until it can be applied: its text, and whether it replaces the text so far */
export type HeldDelta = { text: string; replace?: true }

export type RoomState = {
  room: JackRoomView
  messages: JackMessageView[]
  /** Deltas that can't be applied yet (they came after a gap, or before their message), by message id then seq */
  pending: Record<string, Record<number, HeldDelta>>
  /** Tool parts for messages not seen yet, by message id */
  pendingParts: Record<string, JackToolPart[]>
  /** Finished replies whose done event came trimmed, until a snapshot brings them whole */
  incomplete: Record<string, true>
  /** Something is missing: fetch a fresh snapshot */
  needsResync: boolean
  /** Snapshots in a row (or failed fetches) that didn't close the gap, so the page can back off and try again */
  resyncAttempts: number
  /** The live status of each proposal made in this room that the page has heard about, by proposal id */
  proposals: Record<string, JackProposalState>
}

export type RoomSnapshotData = {
  room: JackRoomView
  messages: JackMessageView[]
  /** The room's proposals' statuses as the database has them (G4); absent until then */
  proposals?: Record<string, JackProposalState>
}

/** Live events, a snapshot, or word that fetching a snapshot failed (so the page backs off and tries again) */
export type RoomAction = JackRoomEvent | ({ type: "snapshot" } & RoomSnapshotData) | { type: "resync_failed" }

type Held = Pick<RoomState, "pending" | "pendingParts" | "incomplete">

export function initRoomState({ room, messages, proposals = {} }: RoomSnapshotData): RoomState {
  return { room, messages: [...messages].sort(byTime), pending: {}, pendingParts: {}, incomplete: {}, needsResync: false, resyncAttempts: 0, proposals }
}

export function roomReducer(state: RoomState, action: RoomAction): RoomState {
  switch (action.type) {
    case "snapshot": {
      const room = newerRoom(state.room, action.room)
      const proposals = action.proposals ? mergeProposals(state.proposals, action.proposals) : state.proposals
      let messages = state.messages
      let incomplete = state.incomplete
      for (const message of action.messages) {
        if (incomplete[message.id] && isFinal(message)) {
          // The database has the whole reply the trimmed done event left out
          incomplete = { ...incomplete }
          delete incomplete[message.id]
          messages = replace(messages, message)
        } else messages = upsert(messages, message)
      }
      let held: Held = { pending: state.pending, pendingParts: state.pendingParts, incomplete }
      for (const id of new Set([...Object.keys(held.pending), ...Object.keys(held.pendingParts)])) ({ messages, held } = drain(messages, held, id))
      return settle({ ...state, room, proposals }, messages, held, true)
    }

    case "resync_failed":
      return state.needsResync ? { ...state, resyncAttempts: state.resyncAttempts + 1 } : state

    case "room.updated": {
      const room = newerRoom(state.room, action.room)
      return room === state.room ? state : { ...state, room }
    }

    case "proposal.updated": {
      if (action.roomId !== state.room.id) return state
      const { id, status, result } = action.proposal
      const proposals = mergeProposals(state.proposals, { [id]: result === undefined ? { status } : { status, result } })
      return proposals === state.proposals ? state : { ...state, proposals }
    }

    case "message.created": {
      const messages = action.answers?.length ? markAnswered(state.messages, action.answers) : state.messages
      const drained = drain(upsert(messages, action.message), heldOf(state), action.message.id)
      return settle(state, drained.messages, drained.held, false)
    }

    case "message.delta": {
      const message = state.messages.find((m) => m.id === action.messageId)
      if (message && (isFinal(message) || action.seq <= message.streamSeq)) return state // finished, or a repeat
      if (state.pending[action.messageId]?.[action.seq] !== undefined) return state // a repeat we're holding
      const piece: HeldDelta = action.replace ? { text: action.text, replace: true } : { text: action.text }
      const pending = {
        ...state.pending,
        [action.messageId]: { ...state.pending[action.messageId], [action.seq]: piece },
      }
      const drained = drain(state.messages, { ...heldOf(state), pending }, action.messageId)
      return settle(state, drained.messages, drained.held, false)
    }

    case "message.tool": {
      const index = state.messages.findIndex((m) => m.id === action.messageId)
      if (index === -1) {
        const pendingParts = { ...state.pendingParts, [action.messageId]: upsertPart(state.pendingParts[action.messageId] ?? [], action.part) }
        return settle(state, state.messages, { ...heldOf(state), pendingParts }, false)
      }
      const message = state.messages[index]
      if (isFinal(message)) return state // the done event had every part
      const tools = upsertPart(message.tools, action.part)
      if (tools === message.tools) return state
      const messages = state.messages.slice()
      messages[index] = { ...message, tools }
      return { ...state, messages }
    }

    case "message.done": {
      const id = action.message.id
      const current = state.messages.find((m) => m.id === id)
      let incoming = action.message
      let incomplete = state.incomplete
      if (action.trimmed) {
        // Too big for Realtime: keep the text and displays this viewer already has, and fetch the rest
        if (current && isFinal(current) && !incomplete[id]) return state // already whole
        incoming = current ? fillTrimmed(current, action.message) : action.message
        incomplete = { ...incomplete, [id]: true }
      } else if (incomplete[id]) {
        incomplete = { ...incomplete }
        delete incomplete[id]
      }
      const messages = current && isFinal(current) && action.trimmed ? replace(state.messages, incoming) : upsert(state.messages, incoming)
      const pending = { ...state.pending }
      const pendingParts = { ...state.pendingParts }
      delete pending[id]
      delete pendingParts[id]
      return settle(state, messages, { pending, pendingParts, incomplete }, false)
    }

    default:
      return state
  }
}

/** How far along a status is: a proposal never goes back to an earlier stage */
function proposalStage(status: JackProposalStatusKey): number {
  return status === "PENDING" ? 0 : status === "APPLYING" ? 1 : 2
}

/** Takes each incoming status unless it's behind the one this viewer has; returns `known` itself when nothing changes */
function mergeProposals(known: Record<string, JackProposalState>, incoming: Record<string, JackProposalState>): Record<string, JackProposalState> {
  let merged: Record<string, JackProposalState> | null = null
  for (const [id, next] of Object.entries(incoming)) {
    const current = known[id]
    if (current && (proposalStage(next.status) < proposalStage(current.status) || JSON.stringify(current) === JSON.stringify(next))) continue
    merged ??= { ...known }
    merged[id] = next
  }
  return merged ?? known
}

function heldOf(state: RoomState): Held {
  return { pending: state.pending, pendingParts: state.pendingParts, incomplete: state.incomplete }
}

/** A trimmed done event, filled in from the copy this viewer has: its text if the event had to drop it, and its tools' displays */
function fillTrimmed(current: JackMessageView, trimmed: JackMessageView): JackMessageView {
  const tools = trimmed.tools.length
    ? trimmed.tools.map((part) => {
        const mine = current.tools.find((p) => p.id === part.id)
        return mine && !part.displays.length ? { ...part, displays: mine.displays } : part
      })
    : current.tools
  return { ...trimmed, content: trimmed.content || current.content, tools }
}

/** Puts `incoming` in place of the message with its id (or adds it), whichever copy is further along */
function replace(messages: JackMessageView[], incoming: JackMessageView): JackMessageView[] {
  const index = messages.findIndex((m) => m.id === incoming.id)
  if (index === -1) return [...messages, incoming].sort(byTime)
  const copy = messages.slice()
  copy[index] = incoming
  return copy
}

function newerRoom(current: JackRoomView, incoming: JackRoomView): JackRoomView {
  return incoming.updatedAt >= current.updatedAt ? incoming : current
}

function isFinal(message: JackMessageView) {
  return message.status !== "streaming"
}

function byTime(a: JackMessageView, b: JackMessageView) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** The officer messages a new reply answers, marked so (a message is answered for good once it is) */
function markAnswered(messages: JackMessageView[], ids: string[]): JackMessageView[] {
  let copy: JackMessageView[] | null = null
  messages.forEach((message, index) => {
    if (message.answered || !ids.includes(message.id)) return
    copy ??= messages.slice()
    copy[index] = { ...message, answered: true }
  })
  return copy ?? messages
}

/** Two finished copies say the same thing (parts compared by what changes; a finished part's displays don't) */
function sameFinal(a: JackMessageView, b: JackMessageView): boolean {
  return (
    a.content === b.content &&
    a.status === b.status &&
    a.streamSeq === b.streamSeq &&
    a.answered === b.answered &&
    a.createdAt === b.createdAt &&
    JSON.stringify(a.author) === JSON.stringify(b.author) &&
    a.tools.length === b.tools.length &&
    a.tools.every((part, i) => {
      const other = b.tools[i]
      return (
        part.id === other.id &&
        part.status === other.status &&
        part.label === other.label &&
        part.at === other.at &&
        part.ms === other.ms &&
        part.error === other.error &&
        part.displays.length === other.displays.length
      )
    })
  )
}

/**
 * Of two copies of one message, the one that's further along; two streaming copies pool their tool
 * parts. When two finished copies say the same thing the current object stays, so a snapshot doesn't
 * re-render every row. Once a copy says a message is answered, it stays answered
 */
function further(current: JackMessageView, incoming: JackMessageView): JackMessageView {
  if (isFinal(current) !== isFinal(incoming)) return isFinal(current) ? current : incoming
  if (isFinal(incoming)) {
    const answered = current.answered || incoming.answered
    const next = incoming.answered === answered ? incoming : { ...incoming, answered }
    return sameFinal(current, next) ? current : next
  }
  const base = incoming.streamSeq > current.streamSeq ? incoming : current
  const other = base === incoming ? current : incoming
  let tools = base.tools
  for (const part of other.tools) {
    // The other copy's part counts only if the newer copy lacks it or still has it running
    const mine = tools.find((p) => p.id === part.id)
    if (!mine || (!isFinishedPart(mine) && isFinishedPart(part))) tools = upsertPart(tools, part)
  }
  return tools === base.tools ? base : { ...base, tools }
}

function upsert(messages: JackMessageView[], incoming: JackMessageView): JackMessageView[] {
  const index = messages.findIndex((m) => m.id === incoming.id)
  if (index === -1) return [...messages, incoming].sort(byTime)
  const next = further(messages[index], incoming)
  if (next === messages[index]) return messages
  const copy = messages.slice()
  copy[index] = next
  return copy
}

function isFinishedPart(part: JackToolPart) {
  return part.status !== "running"
}

/**
 * Adds a part, or replaces the one with its id, unless that would take a finished part back to
 * running. Parts stay in reply order (by position in the text; calls made together keep arrival order).
 */
export function upsertPart(parts: JackToolPart[], incoming: JackToolPart): JackToolPart[] {
  const index = parts.findIndex((p) => p.id === incoming.id)
  if (index === -1) return [...parts, incoming].sort((a, b) => a.at - b.at)
  const current = parts[index]
  if (current === incoming || (isFinishedPart(current) && !isFinishedPart(incoming))) return parts
  const copy = parts.slice()
  copy[index] = incoming
  return copy
}

type Drained = { messages: JackMessageView[]; held: Held }

/** Applies a message's held deltas that now follow on, and its held parts; drops the ones it already has */
function drain(messages: JackMessageView[], held: Held, id: string): Drained {
  if (!held.pending[id] && !held.pendingParts[id]) return { messages, held }
  const index = messages.findIndex((m) => m.id === id)
  if (index === -1) return { messages, held } // still waiting for the message itself

  const message = messages[index]
  const rest = { ...held.pending[id] }
  let { content, streamSeq } = message
  if (!isFinal(message)) {
    while (rest[streamSeq + 1] !== undefined) {
      const piece = rest[streamSeq + 1]
      content = piece.replace ? piece.text : content + piece.text
      delete rest[streamSeq + 1]
      streamSeq++
    }
  }
  for (const seq of Object.keys(rest)) if (isFinal(message) || Number(seq) <= streamSeq) delete rest[Number(seq)]

  let tools = message.tools
  if (!isFinal(message)) for (const part of held.pendingParts[id] ?? []) tools = upsertPart(tools, part)

  const pending = { ...held.pending }
  if (Object.keys(rest).length) pending[id] = rest
  else delete pending[id]
  const pendingParts = { ...held.pendingParts }
  delete pendingParts[id]

  if (streamSeq === message.streamSeq && tools === message.tools) return { messages, held: { ...held, pending, pendingParts } }
  const copy = messages.slice()
  copy[index] = { ...message, content, streamSeq, tools }
  return { messages: copy, held: { ...held, pending, pendingParts } }
}

function settle(state: RoomState, messages: JackMessageView[], held: Held, fromSnapshot: boolean): RoomState {
  const needsResync = [held.pending, held.pendingParts, held.incomplete].some((group) => Object.keys(group).length > 0)
  const resyncAttempts = !needsResync ? 0 : fromSnapshot ? state.resyncAttempts + 1 : state.resyncAttempts
  return { room: state.room, messages, pending: held.pending, pendingParts: held.pendingParts, incomplete: held.incomplete, needsResync, resyncAttempts, proposals: state.proposals }
}

/** Quiet this long with officer messages no reply has picked up (and nothing streaming), the run stopped short of them */
export const STALL_QUIET_MS = 20_000
/**
 * Quiet this long with a reply still streaming, the run that was writing it died: no live run goes
 * quiet longer than its function lives, and by then its room lock is stale, so asking Jack to continue
 * takes over (closing the half-written reply) and answers what's waiting
 */
export const STUCK_QUIET_MS = ROOM_LOCK_STALE_MS + 15_000

/**
 * What the room may be stuck on, before counting how long it's been quiet: "unanswered" when an
 * officer message hasn't been picked up by a reply (`answered`, not the order: one posted while a reply
 * was being set up sorts above it) and nothing is streaming; "stuck" when a reply is still streaming.
 * An officer message that expects no answer (a mention-mode room, no mention) never counts. Null when
 * nothing is waiting
 */
export function stallCandidate(messages: JackMessageView[]): "unanswered" | "stuck" | null {
  if (messages.some((m) => m.status === "streaming")) return "stuck"
  return messages.some((m) => (m.author.kind === "user" || m.continues) && !m.answered && m.expectsAnswer !== false) ? "unanswered" : null
}

/** How long a stall candidate has to stay quiet before the room offers to ask Jack to continue */
export function stallQuietMs(candidate: "unanswered" | "stuck"): number {
  return candidate === "stuck" ? STUCK_QUIET_MS : STALL_QUIET_MS
}
