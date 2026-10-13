import type { JackMessageView, JackRoomEvent } from "./types"

/**
 * A room's messages as one viewer sees them, built from a snapshot (the database) plus the live
 * events on the room's channel. Pure, so the page and the tests share it.
 *
 * Streaming replies arrive as numbered deltas. The database saves a reply about once a second, so
 * a snapshot can trail the live stream: a viewer who opens a room mid-answer starts from the
 * snapshot and applies only the deltas after its `streamSeq`. A delta that skips ahead is held
 * until the missing ones turn up or a newer snapshot covers them; meanwhile `needsResync` asks the
 * page for one. The done event carries the whole reply, so a reply always ends complete.
 */
export type RoomState = {
  messages: JackMessageView[]
  /** Deltas that can't be applied yet (they came after a gap, or before their message), by message id then seq */
  pending: Record<string, Record<number, string>>
  /** Something is missing: fetch a fresh snapshot */
  needsResync: boolean
  /** Snapshots in a row that didn't close the gap, so the page can back off and try again */
  resyncAttempts: number
}

export type RoomAction = JackRoomEvent | { type: "snapshot"; messages: JackMessageView[] }

export function initRoomState(messages: JackMessageView[]): RoomState {
  return { messages: [...messages].sort(byTime), pending: {}, needsResync: false, resyncAttempts: 0 }
}

export function roomReducer(state: RoomState, action: RoomAction): RoomState {
  switch (action.type) {
    case "snapshot": {
      let messages = state.messages
      for (const message of action.messages) messages = upsert(messages, message)
      let pending = state.pending
      for (const id of Object.keys(pending)) ({ messages, pending } = drain(messages, pending, id))
      return settle(state, messages, pending, true)
    }

    case "message.created": {
      const messages = upsert(state.messages, action.message)
      return settle(state, ...unpack(drain(messages, state.pending, action.message.id)), false)
    }

    case "message.delta": {
      const message = state.messages.find((m) => m.id === action.messageId)
      if (message && (isFinal(message) || action.seq <= message.streamSeq)) return state // finished, or a repeat
      if (state.pending[action.messageId]?.[action.seq] !== undefined) return state // a repeat we're holding
      const pending = {
        ...state.pending,
        [action.messageId]: { ...state.pending[action.messageId], [action.seq]: action.text },
      }
      return settle(state, ...unpack(drain(state.messages, pending, action.messageId)), false)
    }

    case "message.done": {
      const messages = upsert(state.messages, action.message)
      const pending = { ...state.pending }
      delete pending[action.message.id]
      return settle(state, messages, pending, false)
    }

    default:
      return state
  }
}

function isFinal(message: JackMessageView) {
  return message.status !== "streaming"
}

function byTime(a: JackMessageView, b: JackMessageView) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Of two copies of one message, the one that's further along */
function further(current: JackMessageView, incoming: JackMessageView): JackMessageView {
  if (isFinal(current) !== isFinal(incoming)) return isFinal(current) ? current : incoming
  if (isFinal(incoming)) return incoming
  return incoming.streamSeq > current.streamSeq ? incoming : current
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

type Drained = { messages: JackMessageView[]; pending: RoomState["pending"] }

/** Applies a message's held deltas that now follow on, and drops the ones it already has */
function drain(messages: JackMessageView[], pending: RoomState["pending"], id: string): Drained {
  const held = pending[id]
  if (!held) return { messages, pending }
  const index = messages.findIndex((m) => m.id === id)
  if (index === -1) return { messages, pending } // still waiting for the message itself

  const message = messages[index]
  const rest = { ...held }
  let { content, streamSeq } = message
  if (!isFinal(message)) {
    while (rest[streamSeq + 1] !== undefined) {
      content += rest[streamSeq + 1]
      delete rest[streamSeq + 1]
      streamSeq++
    }
  }
  for (const seq of Object.keys(rest)) if (isFinal(message) || Number(seq) <= streamSeq) delete rest[Number(seq)]

  const nextPending = { ...pending }
  if (Object.keys(rest).length) nextPending[id] = rest
  else delete nextPending[id]

  if (streamSeq === message.streamSeq) return { messages, pending: nextPending }
  const copy = messages.slice()
  copy[index] = { ...message, content, streamSeq }
  return { messages: copy, pending: nextPending }
}

function unpack(drained: Drained): [JackMessageView[], RoomState["pending"]] {
  return [drained.messages, drained.pending]
}

function settle(state: RoomState, messages: JackMessageView[], pending: RoomState["pending"], fromSnapshot: boolean): RoomState {
  const needsResync = Object.keys(pending).length > 0
  const resyncAttempts = !needsResync ? 0 : fromSnapshot ? state.resyncAttempts + 1 : state.resyncAttempts
  return { messages, pending, needsResync, resyncAttempts }
}
