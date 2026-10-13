"use server"

import { revalidatePath } from "next/cache"
import { requireOfficer } from "@/server/auth/guards"
import { createAuditLog } from "@/server/audit/log"
import { createRoom, getRoomSnapshot, postOfficerMessage, type RoomSnapshot } from "@/server/jack/rooms"
import { jackMessageSchema, jackRoomIdSchema, jackRoomTitleSchema } from "@/schemas/jack.schema"
import type { ActionResult } from "@/lib/action-result"
import type { JackMessageView } from "@/lib/jack/types"

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

/** A room's messages as saved right now, including a reply mid-stream; the page reconciles live deltas against it */
export async function loadJackRoomSnapshot(roomId: string): Promise<ActionResult<RoomSnapshot>> {
  await requireOfficer()

  const id = jackRoomIdSchema.safeParse(roomId)
  if (!id.success) return { ok: false, error: ROOM_GONE }

  const snapshot = await getRoomSnapshot(id.data)
  if (!snapshot) return { ok: false, error: ROOM_GONE }
  return { ok: true, data: snapshot }
}
