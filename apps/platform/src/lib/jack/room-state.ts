import type { JackToolPart } from "./parts"
import type { JackMessageView, JackRoomEvent, JackRoomView } from "./types"

/**
 * A room's messages as one viewer sees them, built from a snapshot (the database) plus the live
 * events on the room's channel. Pure, so the page and the tests share it.
 *
 * Streaming replies arrive as numbered deltas. The database saves a reply about once a second, so
 * a snapshot can trail the live stream: a viewer who opens a room mid-answer starts from the
 * snapshot and applies only the deltas after its `streamSeq`. A delta that skips ahead is held
 * until the missing ones turn up or a newer snapshot covers them; meanwhile `needsResync` asks the
 * page for one. The done event carries the whole reply, so a reply always ends complete.
 *
 * Tool calls arrive as parts, each replacing the part with the same id. They aren't numbered, so a
 * part never goes back from finished (done or error) to running, and a snapshot's parts merge with
 * the live ones rather than replacing them. A part for a message not seen yet is held like a delta.
 *
 * The room's own settings (its persona) come the same two ways; the newer copy wins.
 */
export type RoomState = {
  room: JackRoomView
  messages: JackMessageView[]
  /** Deltas that can't be applied yet (they came after a gap, or before their message), by message id then seq */
  pending: Record<string, Record<number, string>>
  /** Tool parts for messages not seen yet, by message id */
  pendingParts: Record<string, JackToolPart[]>
  /** Something is missing: fetch a fresh snapshot */
  needsResync: boolean
  /** Snapshots in a row that didn't close the gap, so the page can back off and try again */
  resyncAttempts: number
}

export type RoomSnapshotData = { room: JackRoomView; messages: JackMessageView[] }

export type RoomAction = JackRoomEvent | ({ type: "snapshot" } & RoomSnapshotData)

type Held = Pick<RoomState, "pending" | "pendingParts">

export function initRoomState({ room, messages }: RoomSnapshotData): RoomState {
  return { room, messages: [...messages].sort(byTime), pending: {}, pendingParts: {}, needsResync: false, resyncAttempts: 0 }
}

export function roomReducer(state: RoomState, action: RoomAction): RoomState {
  switch (action.type) {
    case "snapshot": {
      const room = newerRoom(state.room, action.room)
      let messages = state.messages
      for (const message of action.messages) messages = upsert(messages, message)
      let held: Held = { pending: state.pending, pendingParts: state.pendingParts }
      for (const id of new Set([...Object.keys(held.pending), ...Object.keys(held.pendingParts)])) ({ messages, held } = drain(messages, held, id))
      return settle({ ...state, room }, messages, held, true)
    }

    case "room.updated": {
      const room = newerRoom(state.room, action.room)
      return room === state.room ? state : { ...state, room }
    }

    case "message.created": {
      const drained = drain(upsert(state.messages, action.message), heldOf(state), action.message.id)
      return settle(state, drained.messages, drained.held, false)
    }

    case "message.delta": {
      const message = state.messages.find((m) => m.id === action.messageId)
      if (message && (isFinal(message) || action.seq <= message.streamSeq)) return state // finished, or a repeat
      if (state.pending[action.messageId]?.[action.seq] !== undefined) return state // a repeat we're holding
      const pending = {
        ...state.pending,
        [action.messageId]: { ...state.pending[action.messageId], [action.seq]: action.text },
      }
      const drained = drain(state.messages, { pending, pendingParts: state.pendingParts }, action.messageId)
      return settle(state, drained.messages, drained.held, false)
    }

    case "message.tool": {
      const index = state.messages.findIndex((m) => m.id === action.messageId)
      if (index === -1) {
        const pendingParts = { ...state.pendingParts, [action.messageId]: upsertPart(state.pendingParts[action.messageId] ?? [], action.part) }
        return settle(state, state.messages, { pending: state.pending, pendingParts }, false)
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
      const messages = upsert(state.messages, action.message)
      const pending = { ...state.pending }
      const pendingParts = { ...state.pendingParts }
      delete pending[action.message.id]
      delete pendingParts[action.message.id]
      return settle(state, messages, { pending, pendingParts }, false)
    }

    default:
      return state
  }
}

function heldOf(state: RoomState): Held {
  return { pending: state.pending, pendingParts: state.pendingParts }
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

/** Of two copies of one message, the one that's further along; two streaming copies pool their tool parts */
function further(current: JackMessageView, incoming: JackMessageView): JackMessageView {
  if (isFinal(current) !== isFinal(incoming)) return isFinal(current) ? current : incoming
  if (isFinal(incoming)) return incoming
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
      content += rest[streamSeq + 1]
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

  if (streamSeq === message.streamSeq && tools === message.tools) return { messages, held: { pending, pendingParts } }
  const copy = messages.slice()
  copy[index] = { ...message, content, streamSeq, tools }
  return { messages: copy, held: { pending, pendingParts } }
}

function settle(state: RoomState, messages: JackMessageView[], held: Held, fromSnapshot: boolean): RoomState {
  const needsResync = Object.keys(held.pending).length > 0 || Object.keys(held.pendingParts).length > 0
  const resyncAttempts = !needsResync ? 0 : fromSnapshot ? state.resyncAttempts + 1 : state.resyncAttempts
  return { room: state.room, messages, pending: held.pending, pendingParts: held.pendingParts, needsResync, resyncAttempts }
}
