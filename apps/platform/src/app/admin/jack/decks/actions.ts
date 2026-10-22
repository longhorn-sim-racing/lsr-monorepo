"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import type { ActionResult } from "@/lib/action-result"
import { deckPageUrl } from "@/lib/jack/decks"
import { JACK_EVENT } from "@/lib/jack/types"
import { createAuditLog } from "@/server/audit/log"
import { requireOfficer } from "@/server/auth/guards"
import { prisma } from "@/server/db"
import { broadcastRoomEvent } from "@/server/jack/broadcast"
import { restoreDeckVersion } from "@/server/jack/decks/service"
import { jackMessageInclude, toMessageView } from "@/server/jack/messages"

const restoreSchema = z.object({ deckId: z.uuid("That deck doesn't exist"), version: z.number().int().min(1) })

/**
 * Brings back an earlier version of a deck from the deck page (#177), as its newest version. The room
 * the deck was made in gets a note, so Jack knows the slides changed.
 */
export async function restoreJackDeckVersion(deckId: string, version: number): Promise<ActionResult<{ version: number }>> {
  const officer = await requireOfficer()
  const parsed = restoreSchema.safeParse({ deckId, version })
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message }

  const change = await restoreDeckVersion(deckId, version, { userId: officer.id })
  if (!change.ok) return { ok: false, error: "That version doesn't exist anymore." }
  const deck = change.deck
  if (!change.changed) return { ok: true, data: { version: deck.version } }

  await createAuditLog({
    actorUserId: officer.id,
    actionType: "UPDATE",
    entityType: "JACK_DECK",
    entityId: deck.id,
    summary: `Restored version ${version} of Jack deck “${deck.title}” (now version ${deck.version})`,
    before: { version: version },
    after: { version: deck.version },
  })

  if (deck.roomId) {
    try {
      const note = await prisma.jackMessage.create({
        data: {
          roomId: deck.roomId,
          kind: "system",
          authorUserId: officer.id,
          content: `${officer.displayName} restored version ${version} of the deck “${deck.title}” (id ${deck.id}) on the deck page; it's now version ${deck.version}`,
        },
        include: jackMessageInclude,
      })
      await broadcastRoomEvent(deck.roomId, { type: JACK_EVENT.created, message: toMessageView(note) })
    } catch (error) {
      console.error(`[jack] Couldn't post the restore note in room ${deck.roomId}:`, error)
    }
  }

  revalidatePath(deckPageUrl(deck.id))
  return { ok: true, data: { version: deck.version } }
}
