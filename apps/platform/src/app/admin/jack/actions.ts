"use server"

import { revalidatePath } from "next/cache"
import { requireOfficer } from "@/server/auth/guards"
import { createAuditLog } from "@/server/audit/log"
import { createRoom, getRoomSnapshot, postOfficerMessage, renameRoom, resumeRoom, setRoomPersona, type RoomSnapshot } from "@/server/jack/rooms"
import { ROOM_GONE, unavailableMessage } from "@/server/jack/room-settings"
import { AttachmentError, attachmentProblem } from "@/server/jack/files/attach"
import { createUpload, removeUpload } from "@/server/jack/files/service"
import { jackFileIdSchema, jackPersonaSwitchSchema, jackPostSchema, jackRoomIdSchema, jackRoomRenameSchema, jackRoomTitleSchema, jackUploadSchema } from "@/schemas/jack.schema"
import type { ActionResult } from "@/lib/action-result"
import type { JackUploadTicket } from "@/lib/jack/files"
import { JACK_PERSONA_NAME, type JackMessageView, type JackRoomView } from "@/lib/jack/types"

export async function createJackRoom(formData: FormData): Promise<ActionResult<{ roomId: string }>> {
  const officer = await requireOfficer()

  const title = jackRoomTitleSchema.safeParse(String(formData.get("title") ?? ""))
  if (!title.success) return { ok: false, error: title.error.issues[0].message }

  const room = await createRoom(officer.id, title.data)

  await createAuditLog({
    actorUserId: officer.id,
    actionType: "CREATE",
    entityType: "JACK_ROOM",
    entityId: room.id,
    summary: `Opened Jack room${room.title ? `: ${room.title}` : ""}`,
    after: room,
  })

  revalidatePath("/admin/jack")
  return { ok: true, data: { roomId: room.id } }
}

/**
 * Posts an officer's message to a room, with the files they attached (READY uploads of theirs in this
 * room, at most 10). Jack answers on the server; the reply streams to everyone in the room
 */
export async function postJackMessage(roomId: string, content: string, fileIds: string[] = []): Promise<ActionResult<JackMessageView>> {
  // The answer runs in this function after the response; its time limit counts from here
  const startedAt = Date.now()
  const officer = await requireOfficer()

  const parsed = jackPostSchema.safeParse({ roomId, content, fileIds })
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message }

  const attachProblem = await attachmentProblem(parsed.data.roomId, officer.id, parsed.data.fileIds)
  if (attachProblem) return { ok: false, error: attachProblem }

  let message: JackMessageView | null
  try {
    message = await postOfficerMessage(parsed.data.roomId, officer.id, parsed.data.content, { startedAt, fileIds: parsed.data.fileIds })
  } catch (error) {
    if (error instanceof AttachmentError) return { ok: false, error: error.message }
    throw error
  }
  if (!message) return { ok: false, error: await unavailableMessage(parsed.data.roomId) }

  // No revalidatePath: it would re-render this room for nothing (the page is live), and the
  // room list is rendered fresh on every visit
  return { ok: true, data: message }
}

/**
 * Starts attaching a file in a room (G5): checks its name, type and size, saves it as UPLOADING and
 * returns where the browser uploads it (a signed Supabase Storage URL for exactly this file's path).
 * The browser then registers it (POST /api/admin/jack/files/[id]/register), a route rather than an
 * action, since server actions run one at a time and registering can take seconds.
 */
export async function createJackUpload(input: { roomId: string; filename: string; size: number; type: string }): Promise<ActionResult<JackUploadTicket>> {
  const officer = await requireOfficer()

  const parsed = jackUploadSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message }

  const result = await createUpload(officer.id, parsed.data)
  return result.ok ? result : { ok: false, error: result.error }
}

/** Removes a file the officer attached but hasn't sent (and its stored copies) */
export async function removeJackUpload(fileId: string): Promise<ActionResult> {
  const officer = await requireOfficer()

  const id = jackFileIdSchema.safeParse(fileId)
  if (!id.success) return { ok: true }

  const result = await removeUpload(id.data, officer.id)
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}

/**
 * Asks Jack to continue in a room where officer messages sit unanswered (a run ran out of time, or
 * died mid-reply). Starts a run after the response, like posting does. When a run still holds the
 * room it says so instead. Not audited: it only answers messages officers already posted.
 */
export async function resumeJackRoom(roomId: string): Promise<ActionResult> {
  const startedAt = Date.now()
  await requireOfficer()

  const id = jackRoomIdSchema.safeParse(roomId)
  if (!id.success) return { ok: false, error: ROOM_GONE }

  const resumed = await resumeRoom(id.data, { startedAt })
  if (!resumed) return { ok: false, error: await unavailableMessage(id.data) }
  if (resumed === "busy") {
    return { ok: false, error: "Jack is still working in this room. If nothing comes through, try again in a few minutes." }
  }
  return { ok: true }
}

/**
 * A room's messages as saved right now, including a reply mid-stream; the page reconciles live deltas
 * against it. Archived rooms too (read-only), and the replies' ratings as this officer sees them
 */
export async function loadJackRoomSnapshot(roomId: string): Promise<ActionResult<RoomSnapshot>> {
  const officer = await requireOfficer()

  const id = jackRoomIdSchema.safeParse(roomId)
  if (!id.success) return { ok: false, error: ROOM_GONE }

  const snapshot = await getRoomSnapshot(id.data, { viewerId: officer.id })
  if (!snapshot) return { ok: false, error: ROOM_GONE }
  return { ok: true, data: snapshot }
}

/**
 * Switches which model answers in a room (Jack, Lift or Stand). It's per room, not per message, so the
 * room's prompt cache survives. Posts a note to the room saying who switched it.
 */
export async function setJackRoomPersona(
  roomId: string,
  persona: string
): Promise<ActionResult<{ room: JackRoomView; message: JackMessageView | null }>> {
  const officer = await requireOfficer()

  const parsed = jackPersonaSwitchSchema.safeParse({ roomId, persona })
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message }

  const result = await setRoomPersona(parsed.data.roomId, officer, parsed.data.persona)
  if (!result) return { ok: false, error: await unavailableMessage(parsed.data.roomId) }
  if (!result.changed) return { ok: true, data: { room: result.room, message: null } }

  await createAuditLog({
    actorUserId: officer.id,
    actionType: "UPDATE",
    entityType: "JACK_ROOM",
    entityId: result.room.id,
    summary: `Switched Jack room to ${JACK_PERSONA_NAME[result.room.persona]}`,
    before: { persona: result.before },
    after: { persona: result.room.persona },
  })

  // No revalidatePath, as with posting: the room is live and the list renders fresh on every visit
  return { ok: true, data: { room: result.room, message: result.message } }
}

/** Renames a room. Any officer can, any time; posts a note to the room saying who renamed it */
export async function renameJackRoom(
  roomId: string,
  title: string
): Promise<ActionResult<{ room: JackRoomView; message: JackMessageView | null }>> {
  const officer = await requireOfficer()

  const parsed = jackRoomRenameSchema.safeParse({ roomId, title })
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message }

  const result = await renameRoom(parsed.data.roomId, officer, parsed.data.title)
  if (!result) return { ok: false, error: await unavailableMessage(parsed.data.roomId) }
  if (!result.changed) return { ok: true, data: { room: result.room, message: null } }

  await createAuditLog({
    actorUserId: officer.id,
    actionType: "UPDATE",
    entityType: "JACK_ROOM",
    entityId: result.room.id,
    summary: `Renamed Jack room to ${result.room.title}`,
    before: { title: result.before },
    after: { title: result.room.title },
  })

  // The room list renders fresh on every visit; the open room hears it live
  return { ok: true, data: { room: result.room, message: result.message } }
}
