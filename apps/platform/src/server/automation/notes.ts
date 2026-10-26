import type { Prisma } from "@prisma/client"
import { JACK_EVENT } from "@/lib/jack/types"
import { prisma } from "@/server/db"
import type { RoomBroadcaster } from "@/server/jack/broadcast"
import { jackMessageInclude, toMessageView, type JackMessageRow } from "@/server/jack/messages"

/**
 * Room notes the automations post (design §11). A `scheduled` note is a question for Jack, answered
 * in a reply of its own as the officer it names (`authorUserId`), with no web tools and no knowledge
 * saves; any other note is a plain record ("Paused the recurring question …"). Every note carries the
 * job's key (`jobKey`), so the job finds its own notes and a scheduled reply's history holds only them.
 */

/** The longest note kept (the digest's full list fits well within it) */
export const NOTE_MAX_CHARS = 12_000

export type AutomationNote = {
  roomId: string
  jobKey: string
  content: string
  /** A question for Jack (answered), rather than a record */
  scheduled?: boolean
  /** The officer it's answered as (scheduled notes), or whose setting it records; null for none */
  authorUserId?: string | null
}

function clip(text: string): string {
  return text.length > NOTE_MAX_CHARS ? `${text.slice(0, NOTE_MAX_CHARS - 1)}…` : text
}

/**
 * Writes a note without telling anyone, in `db` (a transaction, for a scheduled note posted under the
 * automation cap's lock). Announce it once that's committed
 */
export function insertAutomationNote(note: AutomationNote, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<JackMessageRow> {
  return db.jackMessage.create({
    data: { roomId: note.roomId, kind: "system", content: clip(note.content), jobKey: note.jobKey, scheduled: note.scheduled ?? false, authorUserId: note.authorUserId ?? null },
    include: jackMessageInclude,
  })
}

/** Tells everyone watching the room about a note */
export async function announceAutomationNote(row: JackMessageRow, broadcast: RoomBroadcaster): Promise<void> {
  await broadcast(row.roomId, { type: JACK_EVENT.created, message: toMessageView(row) })
}

/** Posts a note and tells everyone watching the room */
export async function postAutomationNote(note: AutomationNote, broadcast: RoomBroadcaster): Promise<JackMessageRow> {
  const row = await insertAutomationNote(note)
  await announceAutomationNote(row, broadcast)
  return row
}
