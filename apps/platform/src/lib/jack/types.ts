/**
 * What Jack's rooms send and show (#161). Plain JSON only: these go over Realtime Broadcast
 * and into client components, so no Prisma types, Dates or Decimals.
 */

export type JackPersonaKey = "jack" | "lift" | "stand"
export type JackMessageStatusKey = "streaming" | "done" | "error"

export const JACK_PERSONA_NAME: Record<JackPersonaKey, string> = {
  jack: "Jack",
  lift: "Lift",
  stand: "Stand",
}

export type JackAuthor =
  | { kind: "officer"; userId: string | null; displayName: string }
  | { kind: "persona"; persona: JackPersonaKey }

/** A message as a room shows it */
export type JackMessageView = {
  id: string
  roomId: string
  author: JackAuthor
  content: string
  status: JackMessageStatusKey
  /** The last streamed delta included in `content` */
  streamSeq: number
  /** ISO timestamp */
  createdAt: string
}

export type JackRoomSummary = {
  id: string
  title: string | null
  createdByName: string | null
  createdAt: string
  updatedAt: string
}

export function jackRoomTitle(room: { title: string | null }): string {
  return room.title ?? "Untitled room"
}

/** The private Realtime channel a room streams on. The database lets only officers join `jack:%` */
export function jackRoomTopic(roomId: string): string {
  return `jack:room:${roomId}`
}

export const JACK_EVENT = {
  created: "message.created",
  delta: "message.delta",
  done: "message.done",
} as const

/** A new message: an officer's, or a model reply that's about to stream */
export type JackCreatedEvent = { type: typeof JACK_EVENT.created; message: JackMessageView }
/** The next piece of a streaming reply. `seq` counts up from 1 per message with no gaps */
export type JackDeltaEvent = { type: typeof JACK_EVENT.delta; messageId: string; seq: number; text: string }
/** A reply finished (status done or error), with its full text */
export type JackDoneEvent = { type: typeof JACK_EVENT.done; message: JackMessageView }

export type JackRoomEvent = JackCreatedEvent | JackDeltaEvent | JackDoneEvent

/** Who's in a room right now, as each officer's tab tracks it on the channel */
export type JackPresence = { userId: string; displayName: string }
