"use server"

import { revalidatePath } from "next/cache"
import { requireOfficer } from "@/server/auth/guards"
import { createAuditLog } from "@/server/audit/log"
import { createRoom, getRoomSnapshot, postOfficerMessage, resumeRoom, setRoomPersona, type RoomSnapshot } from "@/server/jack/rooms"
import { jackMessageSchema, jackPersonaSwitchSchema, jackRoomIdSchema, jackRoomTitleSchema } from "@/schemas/jack.schema"
import type { ActionResult } from "@/lib/action-result"
import { JACK_PERSONA_NAME, type JackMessageView, type JackRoomView } from "@/lib/jack/types"

const ROOM_GONE = "That room doesn't exist anymore."

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

/** Posts an officer's message to a room. Jack answers on the server; the reply streams to everyone in the room */
export async function postJackMessage(roomId: string, content: string): Promise<ActionResult<JackMessageView>> {
  const officer = await requireOfficer()

  const parsed = jackMessageSchema.safeParse({ roomId, content })
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message }

  const message = await postOfficerMessage(parsed.data.roomId, officer.id, parsed.data.content)
  if (!message) return { ok: false, error: ROOM_GONE }

  // No revalidatePath: it would re-render this room for nothing (the page is live), and the
  // room list is rendered fresh on every visit
  return { ok: true, data: message }
}

/**
 * Asks Jack to continue in a room where officer messages sit unanswered (a run ran out of time, or
 * died mid-reply). Starts a run after the response, like posting does; if one is already answering,
 * nothing changes. Not audited: it only answers messages officers already posted.
 */
export async function resumeJackRoom(roomId: string): Promise<ActionResult> {
  await requireOfficer()

  const id = jackRoomIdSchema.safeParse(roomId)
  if (!id.success) return { ok: false, error: ROOM_GONE }

  if (!(await resumeRoom(id.data))) return { ok: false, error: ROOM_GONE }
  return { ok: true }
}

/** A room's messages as saved right now, including a reply mid-stream; the page reconciles live deltas against it */
export async function loadJackRoomSnapshot(roomId: string): Promise<ActionResult<RoomSnapshot>> {
  await requireOfficer()

  const id = jackRoomIdSchema.safeParse(roomId)
  if (!id.success) return { ok: false, error: ROOM_GONE }

  const snapshot = await getRoomSnapshot(id.data)
  if (!snapshot) return { ok: false, error: ROOM_GONE }
  return { ok: true, data: snapshot }
}

/**
 * Switches which model answers in a room (Jack or Lift). It's per room, not per message, so the
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
  if (!result) return { ok: false, error: ROOM_GONE }
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
