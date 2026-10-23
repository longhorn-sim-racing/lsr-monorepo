"use server"

import { revalidatePath } from "next/cache"
import type { ActionResult } from "@/lib/action-result"
import type { JackFeedbackSummary } from "@/lib/jack/feedback"
import type { JackMessageView, JackRoomView } from "@/lib/jack/types"
import { requireOfficer } from "@/server/auth/guards"
import { createAuditLog } from "@/server/audit/log"
import { setReplyFeedback } from "@/server/jack/feedback"
import { answerModeLabel, ROOM_GONE, setRoomAnswerMode, setRoomArchived, setRoomPinned, unavailableMessage } from "@/server/jack/room-settings"
import { jackAnswerModeSchema, jackFeedbackSchema, jackRoomArchiveSchema, jackRoomPinSchema } from "@/schemas/jack.schema"

/*
 * A room's Jack 2.0 settings (design §10): archive, pin and mention mode, plus officers' ratings of
 * replies. Officers only, like everything in the rooms. Each room change is audited; ratings aren't (they
 * change nothing but the Usage page's counts).
 */

type RoomChange = { room: JackRoomView; message: JackMessageView | null }

/** Archives a room (read-only, out of the list, no Jack runs) or brings it back. Posts a note saying who did it */
export async function archiveJackRoom(roomId: string, archived: boolean): Promise<ActionResult<RoomChange>> {
  const officer = await requireOfficer()

  const parsed = jackRoomArchiveSchema.safeParse({ roomId, archived })
  if (!parsed.success) return { ok: false, error: ROOM_GONE }

  const result = await setRoomArchived(parsed.data.roomId, officer, parsed.data.archived)
  if (!result) return { ok: false, error: ROOM_GONE }
  if (!result.changed) return { ok: true, data: { room: result.room, message: null } }

  await createAuditLog({
    actorUserId: officer.id,
    actionType: "UPDATE",
    entityType: "JACK_ROOM",
    entityId: result.room.id,
    summary: `${parsed.data.archived ? "Archived" : "Unarchived"} Jack room${result.room.title ? `: ${result.room.title}` : ""}`,
    before: { archived: !parsed.data.archived },
    after: { archived: parsed.data.archived },
  })

  // The rooms list moves it between its two views
  revalidatePath("/admin/jack")
  return { ok: true, data: { room: result.room, message: result.message } }
}

/** Pins a room (it sorts first in the list and the rail) or unpins it. Pins are shared by every officer */
export async function pinJackRoom(roomId: string, pinned: boolean): Promise<ActionResult<{ room: JackRoomView }>> {
  const officer = await requireOfficer()

  const parsed = jackRoomPinSchema.safeParse({ roomId, pinned })
  if (!parsed.success) return { ok: false, error: ROOM_GONE }

  const result = await setRoomPinned(parsed.data.roomId, parsed.data.pinned)
  if (!result) return { ok: false, error: await unavailableMessage(parsed.data.roomId) }
  if (!result.changed) return { ok: true, data: { room: result.room } }

  await createAuditLog({
    actorUserId: officer.id,
    actionType: "UPDATE",
    entityType: "JACK_ROOM",
    entityId: result.room.id,
    summary: `${parsed.data.pinned ? "Pinned" : "Unpinned"} Jack room${result.room.title ? `: ${result.room.title}` : ""}`,
    before: { pinned: !parsed.data.pinned },
    after: { pinned: parsed.data.pinned },
  })

  revalidatePath("/admin/jack")
  return { ok: true, data: { room: result.room } }
}

/** Sets whether Jack answers every message in a room or only messages that mention him. Posts a note saying who did it */
export async function setJackRoomAnswerMode(roomId: string, mode: string): Promise<ActionResult<RoomChange>> {
  const officer = await requireOfficer()

  const parsed = jackAnswerModeSchema.safeParse({ roomId, mode })
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message }

  const result = await setRoomAnswerMode(parsed.data.roomId, officer, parsed.data.mode)
  if (!result) return { ok: false, error: await unavailableMessage(parsed.data.roomId) }
  if (!result.changed) return { ok: true, data: { room: result.room, message: null } }

  await createAuditLog({
    actorUserId: officer.id,
    actionType: "UPDATE",
    entityType: "JACK_ROOM",
    entityId: result.room.id,
    summary: `Set Jack room to ${answerModeLabel(parsed.data.mode, result.room.persona)}`,
    before: { answerMode: parsed.data.mode === "mention" ? "always" : "mention" },
    after: { answerMode: parsed.data.mode },
  })

  // The room is live; the list doesn't show the mode
  return { ok: true, data: { room: result.room, message: result.message } }
}

/**
 * Rates a reply thumbs up or down, with an optional short note, or takes the rating back (`rating`
 * null). One per officer per reply; a new rating replaces the old one and its note
 */
export async function rateJackReply(messageId: string, rating: "up" | "down" | null, note?: string | null): Promise<ActionResult<{ summary: JackFeedbackSummary }>> {
  const officer = await requireOfficer()

  const parsed = jackFeedbackSchema.safeParse({ messageId, rating, note })
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message }

  const result = await setReplyFeedback({ messageId: parsed.data.messageId, userId: officer.id, rating: parsed.data.rating, note: parsed.data.note })
  if (!result.ok) return result
  return { ok: true, data: { summary: result.summary } }
}
