"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import type { ActionResult } from "@/lib/action-result"
import { deckPageUrl, MAX_DECK_SLIDES } from "@/lib/jack/decks"
import { CAROUSEL_MAX, CAROUSEL_MIN, PUBLISH_HISTORY } from "@/lib/jack/publish"
import { JACK_EVENT } from "@/lib/jack/types"
import { requireOfficer } from "@/server/auth/guards"
import { instagramPublishConnector } from "@/server/connectors/instagram/publish-connector"
import { prisma } from "@/server/db"
import { broadcastRoomEvent } from "@/server/jack/broadcast"
import { jackMessageInclude, toMessageView } from "@/server/jack/messages"
import { captionProblem } from "@/server/jack/publish/caption"
import { addToGallery, describeGalleryAdd, GalleryAlbumGone } from "@/server/jack/publish/gallery"
import { describePublish, publishDeps, PublishRefused, PublishRepeat, startInstagramPublish } from "@/server/jack/publish/instagram"
import { slidesById } from "@/server/jack/publish/slides"

/**
 * The deck page's "Publish to Instagram" and "Add to gallery" (#188, design §13). An officer pressing
 * the button (after the dialog and a confirm) is the approval, so these apply directly, through the same
 * code an applied proposal runs (startInstagramPublish, addToGallery), audited as the officer with
 * `via: "deck_page"`. The deck's room gets a note, so Jack knows what went out.
 */

const slideIds = z.array(z.string().regex(/^[A-Za-z0-9_-]{4,32}$/)).min(1).max(MAX_DECK_SLIDES)

const publishSchema = z.object({
  deckId: z.uuid(),
  version: z.number().int().min(1),
  slideIds: slideIds.max(CAROUSEL_MAX),
  type: z.enum(["post", "carousel", "story"]),
  caption: z.string().trim().max(2_200).default(""),
  altText: z.string().trim().max(1_000).optional(),
  aiLabel: z.boolean().default(false),
  /** The officer saw it was already sent and confirmed posting it again */
  again: z.boolean().default(false),
})

/** Instagram's API posts in the last 24 hours against its limit, read live for the dialog; null when publishing isn't connected */
export async function readInstagramQuota(): Promise<ActionResult<{ used: number; total: number; account: string | null } | null>> {
  await requireOfficer()
  const client = await instagramPublishConnector.client()
  if (!client) return { ok: true, data: null }
  try {
    const quota = await client.quota()
    return { ok: true, data: { ...quota, account: client.username } }
  } catch {
    return { ok: false, error: "Instagram didn't answer. Try again in a minute." }
  }
}

/** A note in the deck's room, so the room and Jack see what an officer did from the deck page */
async function deckRoomNote(roomId: string | null, officerId: string, content: string) {
  if (!roomId) return
  try {
    const note = await prisma.jackMessage.create({ data: { roomId, kind: "system", authorUserId: officerId, content }, include: jackMessageInclude })
    await broadcastRoomEvent(roomId, { type: JACK_EVENT.created, message: toMessageView(note) })
  } catch (error) {
    console.error(`[jack] Couldn't post the deck page note in room ${roomId}:`, error)
  }
}

/**
 * Posts the picked slides of the deck version on the page: the officer confirmed in the dialog. The same
 * pick already on its way or sent in the last day is refused with `repeat` (a press after a slow answer, a
 * reload, or another officer on the same deck), unless the officer confirms posting it again (`again`)
 */
export async function publishDeckToInstagram(
  input: z.input<typeof publishSchema>,
): Promise<ActionResult<{ state: "published" | "waiting"; permalink: string | null; summary: string }> | { ok: false; error: string; repeat: true }> {
  const officer = await requireOfficer()
  const parsed = publishSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: "Pick the slides and type again; something didn't come through." }
  const p = parsed.data
  const count = p.slideIds.length
  const pickedText = count === 1 ? "1 is picked" : `${count} are picked`
  if (p.type !== "carousel" && count !== 1) return { ok: false, error: `A ${p.type} is one slide; ${pickedText}.` }
  if (p.type === "carousel" && (count < CAROUSEL_MIN || count > CAROUSEL_MAX)) return { ok: false, error: `A carousel takes ${CAROUSEL_MIN} to ${CAROUSEL_MAX} slides; ${pickedText}.` }
  const caption = p.type === "story" ? "" : p.caption
  const problem = caption ? captionProblem(caption) : null
  if (problem) return { ok: false, error: problem }

  const picked = await slidesById(p.deckId, p.version, p.slideIds)
  if (!picked) return { ok: false, error: "That deck version or one of its slides doesn't exist anymore. Reload the page." }
  const client = await instagramPublishConnector.client()
  if (!client) return { ok: false, error: "Instagram publishing isn't switched on (System → Connections). Ask an admin." }

  try {
    const { row, state } = await startInstagramPublish(
      {
        deck: picked.deck,
        slides: picked.slides,
        type: p.type,
        caption,
        altText: p.type === "post" ? p.altText || undefined : undefined,
        aiGenerated: p.aiLabel,
        createdById: officer.id,
        approvedById: officer.id,
        auditMetadata: { via: "deck_page", deckId: picked.deck.id, version: picked.deck.version },
        refuseRepeat: !p.again,
      },
      publishDeps(client),
    )
    const summary = describePublish(row, picked.deck.title)
    await deckRoomNote(picked.deck.roomId, officer.id, `${officer.displayName} on the deck page: ${summary} → ${PUBLISH_HISTORY}`)
    revalidatePath("/admin/instagram")
    return { ok: true, data: { state, permalink: row.permalink, summary } }
  } catch (error) {
    if (error instanceof PublishRepeat) return { ok: false, error: `${error.message} Nothing new was posted.`, repeat: true }
    revalidatePath("/admin/instagram")
    const text = error instanceof Error ? error.message : "It couldn't be posted."
    return { ok: false, error: error instanceof PublishRefused ? `${text} Nothing was posted.` : text }
  }
}

const gallerySchema = z.object({
  deckId: z.uuid(),
  version: z.number().int().min(1),
  slideIds,
  album: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("existing"), id: z.uuid() }),
    z.object({ kind: z.literal("new"), title: z.string().trim().min(1, "Give the new album a title").max(120), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null) }),
  ]),
  alt: z.string().trim().max(300).optional(),
})

/** Adds the picked slides to a gallery album (an existing one or a new one): the officer confirmed in the dialog */
export async function addDeckToGallery(input: z.input<typeof gallerySchema>): Promise<ActionResult<{ summary: string; added: number }>> {
  const officer = await requireOfficer()
  const parsed = gallerySchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Pick the slides and the album again." }
  const p = parsed.data
  if (p.album.kind === "new" && (await prisma.galleryAlbum.findFirst({ where: { title: { equals: p.album.title, mode: "insensitive" } }, select: { id: true } }))) {
    return { ok: false, error: `An album called “${p.album.title}” already exists. Pick it from the list instead.` }
  }
  const picked = await slidesById(p.deckId, p.version, p.slideIds)
  if (!picked) return { ok: false, error: "That deck version or one of its slides doesn't exist anymore. Reload the page." }

  try {
    const result = await addToGallery({
      target: p.album.kind === "existing" ? { albumId: p.album.id } : { newAlbum: { title: p.album.title, date: p.album.date } },
      items: picked.slides.map((slide) => ({ rowId: `slide:${slide.id}`, kind: "slide" as const, deck: picked.deck, slide, alt: p.alt || `${picked.deck.title}, slide ${slide.n}` })),
      actorUserId: officer.id,
      auditMetadata: { via: "deck_page", deckId: picked.deck.id, version: picked.deck.version },
    })
    const summary = describeGalleryAdd(result)
    if (result.added.length) await deckRoomNote(picked.deck.roomId, officer.id, `${officer.displayName} on the deck page: ${summary} → /admin/gallery`)
    revalidatePath(deckPageUrl(picked.deck.id))
    return { ok: true, data: { summary, added: result.added.length } }
  } catch (error) {
    if (error instanceof GalleryAlbumGone) return { ok: false, error: error.message }
    return { ok: false, error: error instanceof Error ? `Couldn't add them: ${error.message}` : "Couldn't add them." }
  }
}
