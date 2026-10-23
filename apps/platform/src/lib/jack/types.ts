import type { JackFileItem, JackToolPart } from "./parts"

/**
 * What Jack's rooms send and show (#161). Plain JSON only: these go over Realtime Broadcast
 * and into client components, so no Prisma types, Dates or Decimals.
 */

export type JackPersonaKey = "jack" | "lift" | "stand"
/** The personas a room can be set to: all three. Stand also does side jobs (naming rooms) */
export type JackRoomPersonaKey = "jack" | "lift" | "stand"
export type JackMessageStatusKey = "streaming" | "done" | "error"

export const JACK_PERSONA_NAME: Record<JackPersonaKey, string> = {
  jack: "Jack",
  lift: "Lift",
  stand: "Stand",
}

/** Harbor Freight product photos: a floor jack, a lift (they don't sell two-post lifts) and jack stands */
export const JACK_PERSONA_AVATAR: Record<JackPersonaKey, string> = {
  jack: "/jack/jack.webp",
  lift: "/jack/lift.webp",
  stand: "/jack/stand.webp",
}

export const JACK_ROOM_PERSONAS: JackRoomPersonaKey[] = ["jack", "lift", "stand"]

export function isJackRoomPersona(value: unknown): value is JackRoomPersonaKey {
  return JACK_ROOM_PERSONAS.includes(value as JackRoomPersonaKey)
}

/** Who a message is from, matching JackMessage.kind: an officer, a model, or the room itself */
export type JackAuthor =
  | {
      kind: "user"
      userId: string | null
      displayName: string
      avatarUrl: string | null
      /** The officer's profile as it was when they posted (JackMessage.authorLabel), e.g. "Technology Director · Technology · CS" (G5) */
      label?: string
    }
  | { kind: "assistant"; persona: JackPersonaKey }
  | { kind: "system" }

/** A file attached to an officer's message (design §5) */
export type JackMessageFile = JackFileItem

/** A message as a room shows it */
export type JackMessageView = {
  id: string
  roomId: string
  author: JackAuthor
  content: string
  /** Tools the reply used, in order; each sits at its `at` position in `content` */
  tools: JackToolPart[]
  status: JackMessageStatusKey
  /** The last streamed delta included in `content` */
  streamSeq: number
  /**
   * Officer messages and continue notes: whether a reply has picked it up (JackMessage.answeredById is
   * set). Always true for other messages, which nobody answers. A message waiting for an answer can sort above the reply
   * that's streaming (it was posted while the reply was being set up), so this, not the order, says
   * what's still waiting
   */
  answered: boolean
  /**
   * A room note asking Jack to keep going on a deck (#177). Answered like an officer message; the
   * room starts a run for it as soon as it sees one waiting
   */
  continues?: true
  /** Files an officer attached, in order (G5) */
  files?: JackMessageFile[]
  /**
   * False for an officer message in a mention-mode room that doesn't mention Jack: it starts no run,
   * waits for no answer, and never makes the room offer to continue. Absent means it expects one
   */
  expectsAnswer?: false
  /** ISO timestamp */
  createdAt: string
}

/** A room's own settings, as its page shows them */
export type JackRoomView = {
  id: string
  title: string | null
  persona: JackRoomPersonaKey
  /** ISO timestamp; the newer copy wins when a snapshot and a live update cross */
  updatedAt: string
  /** ISO timestamp when pinned (pinned rooms sort first); null or absent when not */
  pinnedAt?: string | null
  /** "mention": Jack answers only messages that mention him (design §10). Absent means "always" */
  answerMode?: "always" | "mention"
  /** ISO timestamp when archived (read-only); null or absent when not */
  archivedAt?: string | null
}

export type JackRoomSummary = {
  id: string
  title: string | null
  persona: JackRoomPersonaKey
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
  tool: "message.tool",
  room: "room.updated",
  proposal: "proposal.updated",
} as const

/**
 * A new message: an officer's, a system note, or a model reply that's about to stream. A reply lists
 * the officer messages it answers in `answers`, so viewers can mark them answered
 */
export type JackCreatedEvent = { type: typeof JACK_EVENT.created; message: JackMessageView; answers?: string[] }
/**
 * The next piece of a streaming reply. `seq` counts up from 1 per message with no gaps. With `replace`
 * the text is the reply's whole text so far, replacing what streamed before (the server took some back,
 * e.g. a partial answer the model then declined)
 */
export type JackDeltaEvent = { type: typeof JACK_EVENT.delta; messageId: string; seq: number; text: string; replace?: true }
/**
 * A reply finished (status done or error), with its full text and tools. `trimmed` when it was too big
 * for Realtime: its tool displays (and maybe its text) were left out, and viewers load it from a snapshot
 */
export type JackDoneEvent = { type: typeof JACK_EVENT.done; message: JackMessageView; trimmed?: true }
/** A tool call in a streaming reply started or finished; replaces the part with the same id */
export type JackToolEvent = { type: typeof JACK_EVENT.tool; messageId: string; part: JackToolPart }
/** The room's settings changed (e.g. its persona) */
export type JackRoomUpdatedEvent = { type: typeof JACK_EVENT.room; room: JackRoomView }

/** JackProposal.status (design §3.3) */
export type JackProposalStatusKey = "PENDING" | "APPLYING" | "APPLIED" | "DISCARDED" | "FAILED" | "STALE" | "SUPERSEDED"

/** A link in a proposal's card or result: a site path, or an outside URL (shown with its host) */
export type JackProposalLink = { title: string; url: string }

/** What applying a proposal did (JackProposal.result); the server's ProposalResult */
export type JackProposalResult = {
  /** One line, e.g. "Changed GM 2's start time to 7 PM" */
  summary: string
  /** Where to see the change, e.g. the event's admin page */
  links?: JackProposalLink[]
  /** What it created, by AuditLog entityType and id */
  created?: { type: string; id: string }[]
  /** List kinds: the row ids actually applied */
  appliedRows?: string[]
  /** e.g. { sent: 40, skipped: 2 } */
  counts?: Record<string, number>
}

/** A proposal's live status, as a room keeps it (the card reads it; the reply's display never changes) */
export type JackProposalState = { status: JackProposalStatusKey; result?: JackProposalResult }

/** A proposal in this room was claimed, applied, discarded or went stale (G4) */
export type JackProposalUpdatedEvent = { type: typeof JACK_EVENT.proposal; roomId: string; proposal: { id: string } & JackProposalState }

export type JackRoomEvent = JackCreatedEvent | JackDeltaEvent | JackDoneEvent | JackToolEvent | JackRoomUpdatedEvent | JackProposalUpdatedEvent

/** Who's in a room right now, as each officer's tab tracks it on the channel */
export type JackPresence = { userId: string; displayName: string; avatarUrl: string | null }
