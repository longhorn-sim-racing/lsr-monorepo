import { Prisma, type InstagramPublish } from "@prisma/client"
import { ACTIVE_STATUSES, MEDIA_TYPE, PUBLISH_HISTORY, TYPE_LABEL, type PublishMediaType, type PublishStatus, type PublishType } from "@/lib/jack/publish"
import { JACK_EVENT } from "@/lib/jack/types"
import { redactSecrets } from "@/lib/redact"
import { createAuditLog } from "@/server/audit/log"
import { uploadImageBytes } from "@/server/cloudinary"
import { isLimitReached, isNotReady, isTransient, type ContainerStatus } from "@/server/connectors/instagram/publish"
import type { InstagramPublishClient } from "@/server/connectors/instagram/publish-connector"
import { prisma } from "@/server/db"
import { broadcastRoomEvent } from "@/server/jack/broadcast"
import type { SlideSource } from "@/server/jack/decks/document"
import { getRenderFile } from "@/server/jack/decks/renders"
import type { DeckView } from "@/server/jack/decks/service"
import { jackMessageInclude, toMessageView } from "@/server/jack/messages"
import { mapLimit, plural } from "@/server/jack/proposals/changes/shared"
import { instagramJpeg, type InstagramShape } from "./images"
import { slideSource, type PickedSlide } from "./slides"

/**
 * Posting a deck's slides to Instagram (#188, design §12.6; research/instagram.md §3d to §3g), after an
 * officer approved it: an instagram.publish proposal's Apply, or the deck page's Publish button. Every
 * post is an InstagramPublish row, and the row is how a post is never made twice:
 *
 *   queued       the row exists; the slides become 1080 px JPEGs (instagramJpeg) on Cloudinary, whose
 *                public links Instagram downloads
 *   containers   Instagram's containers are made (one per image, then the carousel's), each saved on the
 *                row as soon as Instagram answers; we wait for them to be FINISHED
 *   publishing   set before media_publish is called, so whoever looks at the row next checks the
 *                container's status (PUBLISHED: find the post; FINISHED: the call didn't take) before
 *                ever calling it again
 *   published    with the post's id and link
 *   failed       with why (redacted); nothing was posted unless the error says otherwise
 *
 * Applying waits up to about 45 s for Instagram to process the images (Meta suggests checking for up to
 * 5 minutes). A post still processing then is left to the instagram-publish.finish job (every 5
 * minutes), or an officer's "Check now" on Content → Instagram. Whoever works a row holds its lease
 * (`claimedAt`) first, so two never work one row. The day's quota (content_publishing_limit) is read
 * before the containers are made and again before publishing, and the site keeps its own cap well under
 * Meta's (CLUB_DAILY_POSTS).
 */

export const SHAPE: Record<PublishType, InstagramShape> = { post: "feed", carousel: "feed", story: "story" }
/**
 * The most posts the site sends to Instagram in 24 hours, well under Meta's quota (50 to 100): Meta's
 * Developer Policy §1.4 asks apps not to spam, and a club account never needs more (research §6)
 */
export const CLUB_DAILY_POSTS = 10

/** How long applying waits for Instagram to finish processing before leaving the rest to the job */
export const APPLY_WAIT_MS = 45_000
/** Whoever works a row holds it this long at most (longer than any function lives) */
export const LEASE_MS = 6 * 60_000
/** After a publish call that got no answer, how long to wait before checking whether it went out and trying again */
export const SETTLE_MS = 2 * 60_000
const POLLS_MS = [2_000, 3_000, 5_000, 5_000, 8_000]
const DAY = 86_400_000

/** InstagramPublish.containerIds: the containers made so far, in slide order, and how the rest are made */
export type PublishContainers = {
  items: string[]
  /** The carousel's own container, made once its items are finished */
  carousel: string | null
  /** The officer chose Instagram's AI label (is_ai_generated) */
  aiGenerated: boolean
  /** When media_publish was last called (ISO), so a call that got no answer is checked before another */
  publishAttemptAt: string | null
}

export function readContainers(value: Prisma.JsonValue | null | undefined): PublishContainers {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  return {
    items: Array.isArray(raw.items) ? raw.items.filter((id): id is string => typeof id === "string") : [],
    carousel: typeof raw.carousel === "string" ? raw.carousel : null,
    aiGenerated: raw.aiGenerated === true,
    publishAttemptAt: typeof raw.publishAttemptAt === "string" ? raw.publishAttemptAt : null,
  }
}

const asJson = (containers: PublishContainers) => containers as unknown as Prisma.InputJsonValue

/** A check failed before anything went to Instagram (a limit): nothing was made or posted */
export class PublishRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PublishRefused"
  }
}

export type PublishDeps = {
  client: InstagramPublishClient
  /** A slide's full-size render (rendered on a cache miss) */
  slidePng(source: SlideSource): Promise<Buffer>
  /** Puts a JPEG on Cloudinary and returns its public link */
  upload(body: Buffer, publicId: string, signal?: AbortSignal): Promise<{ secureUrl: string }>
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  now(): Date
}

export function publishDeps(client: InstagramPublishClient): PublishDeps {
  return {
    client,
    slidePng: async (source) => (await getRenderFile(source, "png")).body,
    upload: (body, publicId, signal) => uploadImageBytes(body, { publicId, filename: "slide.jpg", contentType: "image/jpeg", signal }),
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms)
        signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true })
      }),
    now: () => new Date(),
  }
}

export type StartPublish = {
  deck: DeckView
  slides: PickedSlide[]
  type: PublishType
  caption: string
  altText?: string
  aiGenerated: boolean
  /** The approved proposal: one row per proposal, and a second apply carries on with it */
  proposalId?: string
  /** Who it was for (the officer who asked Jack, or who pressed the button) and who approved it */
  createdById: string | null
  approvedById: string
  /** Added to the audit entry: where the approval came from */
  auditMetadata: Record<string, unknown>
}

export type PublishOutcome = { row: InstagramPublish; state: "published" | "waiting" }

/** What a publish did, in a sentence, for results, notes, the audit log and the page */
export function describePublish(row: Pick<InstagramPublish, "mediaType" | "slideIds" | "status" | "error">, title: string): string {
  const what = `“${title}” as ${TYPE_LABEL[row.mediaType as PublishMediaType] ?? "a post"}${row.mediaType === "CAROUSEL" ? ` of ${row.slideIds.length} slides` : ""}`
  if (row.status === "published") return `Posted ${what} on Instagram.${row.error ? ` ${row.error}` : ""}`
  if (row.status === "failed") return `Couldn't post ${what} on Instagram: ${row.error ?? "it failed."}`
  return `Sent ${what} to Instagram. Instagram is still processing the images; it goes up within a few minutes (Content → Instagram shows when).`
}

/**
 * Posts an approved selection of slides: the site's cap and Instagram's quota first (nothing is made
 * when either is used up), then the row, the images, the containers, and a wait for Instagram, ending
 * published or waiting (the job finishes it). A failure marks the row failed and throws. Writes one audit
 * entry once there's a row.
 */
export async function startInstagramPublish(input: StartPublish, deps: PublishDeps, { waitMs = APPLY_WAIT_MS, signal }: { waitMs?: number; signal?: AbortSignal } = {}): Promise<PublishOutcome> {
  if (input.proposalId) {
    const existing = await prisma.instagramPublish.findUnique({ where: { proposalId: input.proposalId } })
    if (existing) return carryOnExisting(existing, deps, waitMs, signal)
  }

  const now = deps.now()
  const today = await prisma.instagramPublish.count({ where: { createdAt: { gt: new Date(now.getTime() - DAY) }, status: { not: "failed" } } })
  if (today >= CLUB_DAILY_POSTS) throw new PublishRefused(`The site has already sent ${plural(today, "post")} to Instagram in the last 24 hours, the most it sends in a day. Try again tomorrow, or post from the Instagram app.`)
  const quota = await deps.client.quota(signal)
  if (quota.used >= quota.total) throw new PublishRefused(`Instagram's limit of ${quota.total} API posts a day is used up (${quota.used} in the last 24 hours). Try again tomorrow.`)

  const mediaType = MEDIA_TYPE[input.type]
  let row: InstagramPublish
  try {
    row = await prisma.instagramPublish.create({
      data: {
        deckId: input.deck.id,
        version: input.deck.version,
        slideIds: input.slides.map((s) => s.id),
        mediaType,
        caption: input.type === "story" ? "" : input.caption,
        containerIds: asJson({ items: [], carousel: null, aiGenerated: input.aiGenerated, publishAttemptAt: null }),
        status: "queued",
        claimedAt: now,
        proposalId: input.proposalId ?? null,
        createdById: input.createdById,
        approvedById: input.approvedById,
      },
    })
  } catch (error) {
    // Another apply of the same proposal made the row first
    if (input.proposalId && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return carryOnExisting(await prisma.instagramPublish.findUniqueOrThrow({ where: { proposalId: input.proposalId } }), deps, waitMs, signal)
    }
    throw error
  }

  const rowId = row.id
  try {
    // The images, a few at a time, each on Cloudinary under the row's id
    const shape = SHAPE[input.type]
    const urls = await mapLimit(input.slides, 3, async (slide, i) => {
      const jpeg = await instagramJpeg(await deps.slidePng(slideSource(input.deck, slide)), shape)
      return (await deps.upload(jpeg.body, `jack/instagram/${rowId}/${i + 1}`, signal)).secureUrl
    })
    row = await prisma.instagramPublish.update({ where: { id: rowId }, data: { imageUrls: urls } })

    // The containers, in slide order, each saved as soon as Instagram answers
    const containers = readContainers(row.containerIds)
    for (const url of urls) {
      const id = await deps.client.createContainer(
        mediaType === "IMAGE"
          ? { kind: "image", imageUrl: url, caption: input.caption || undefined, altText: input.altText, aiGenerated: input.aiGenerated }
          : mediaType === "STORIES"
            ? { kind: "story", imageUrl: url, aiGenerated: input.aiGenerated }
            : { kind: "carousel_item", imageUrl: url },
        signal,
      )
      containers.items.push(id)
      await prisma.instagramPublish.update({ where: { id: rowId }, data: { containerIds: asJson(containers) } })
    }
    row = await prisma.instagramPublish.update({ where: { id: rowId }, data: { status: "containers" } })
  } catch (error) {
    // No publish call was made: nothing went out
    await failRow(rowId, `Nothing was posted: ${message(error)}`)
    await auditPublish(rowId, input)
    throw error
  }

  try {
    return await carryOn(row, deps, waitMs, signal)
  } finally {
    await auditPublish(rowId, input)
  }
}

/**
 * Waits on a row this caller holds, until it's published, failed, or the wait is over. A check that
 * fails on the way (Instagram didn't answer) leaves the row for the job, saying so on it: the post may
 * still go out, so this never reports it as failed
 */
async function carryOn(row: InstagramPublish, deps: PublishDeps, waitMs: number, signal?: AbortSignal): Promise<PublishOutcome> {
  if (row.status === "published") return { row, state: "published" }
  if (row.status === "failed") throw new Error(row.error ?? "It couldn't be posted.")
  let final: InstagramPublish
  try {
    final = await advanceInstagramPublish(row.id, deps, { until: deps.now().getTime() + waitMs, signal })
  } catch (error) {
    final = await noteCheckFailed(row.id, error)
  }
  if (final.status === "failed") throw new Error(final.error ?? "It couldn't be posted.")
  return { row: final, state: final.status === "published" ? "published" : "waiting" }
}

/** A proposal's row from an earlier apply that stopped partway: carry on with it, unless someone holds it right now */
async function carryOnExisting(row: InstagramPublish, deps: PublishDeps, waitMs: number, signal?: AbortSignal): Promise<PublishOutcome> {
  if (ACTIVE_STATUSES.includes(row.status as PublishStatus) && !(await claimPublish(row.id, deps.now()))) return { row, state: "waiting" }
  return carryOn(row, deps, waitMs, signal)
}

/** Keeps why the last check failed on a row still on its way (the history shows it); the next look tries again */
async function noteCheckFailed(id: string, error: unknown): Promise<InstagramPublish> {
  console.error(`[jack] Checking Instagram post ${id} failed:`, error)
  await prisma.instagramPublish.updateMany({ where: { id, status: { in: ACTIVE_STATUSES } }, data: { error: `The last check with Instagram failed (${message(error)}); it's checked again in a few minutes.`.slice(0, 1_000) } })
  return prisma.instagramPublish.findUniqueOrThrow({ where: { id } })
}

/** Takes a row to work on: only while it's still on its way and nobody else holds it */
export async function claimPublish(id: string, now: Date): Promise<boolean> {
  const { count } = await prisma.instagramPublish.updateMany({
    where: { id, status: { in: ACTIVE_STATUSES }, OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - LEASE_MS) } }] },
    data: { claimedAt: now },
  })
  return count > 0
}

type Step = { next: "wait" | "again" } | { done: InstagramPublish }

/**
 * Moves a row along until it's published or failed, or `until` (epoch ms) comes: checks the containers,
 * makes the carousel's once its items are ready, publishes once Instagram has finished. The caller holds
 * the row's lease, which is let go when this returns with the row still on its way. `notify` posts the
 * outcome as a room note (the job and "Check now"; an apply reports its own).
 */
export async function advanceInstagramPublish(id: string, deps: PublishDeps, { until, signal, notify = false }: { until: number; signal?: AbortSignal; notify?: boolean }): Promise<InstagramPublish> {
  let polls = 0
  try {
    for (;;) {
      const row = await prisma.instagramPublish.findUniqueOrThrow({ where: { id } })
      if (row.status === "published" || row.status === "failed") return row
      const step = await stepOnce(row, deps, signal)
      if ("done" in step) {
        if (notify) await notePublishOutcome(step.done)
        return step.done
      }
      if (step.next === "again") continue
      const wait = POLLS_MS[Math.min(polls++, POLLS_MS.length - 1)]
      if (signal?.aborted || deps.now().getTime() + wait > until) return await prisma.instagramPublish.findUniqueOrThrow({ where: { id } })
      await deps.sleep(wait, signal)
    }
  } finally {
    await prisma.instagramPublish.updateMany({ where: { id, status: { in: ACTIVE_STATUSES } }, data: { claimedAt: null } })
  }
}

async function stepOnce(row: InstagramPublish, deps: PublishDeps, signal?: AbortSignal): Promise<Step> {
  const { client } = deps
  const containers = readContainers(row.containerIds)

  // Only an apply moves a row out of queued; one still queued here was left by a function that died
  if (row.status === "queued") return { done: await failRow(row.id, "It stopped before its images reached Instagram, so nothing was posted. Ask again to post it.") }

  if (row.status === "containers") {
    if (!row.imageUrls.length || containers.items.length < row.imageUrls.length) {
      return { done: await failRow(row.id, "It stopped before every image reached Instagram, so nothing was posted. Ask again to post it.") }
    }
    const statuses = await Promise.all(containers.items.map((cid) => client.containerStatus(cid, signal)))
    // A single image or story that's already PUBLISHED: a publish nobody recorded. Find the post
    if (row.mediaType !== "CAROUSEL" && statuses[0].code === "PUBLISHED") return { done: await reconcile(row, deps, signal) }
    const problem = containerProblem(statuses, row.mediaType === "CAROUSEL")
    if (problem) return { done: await failRow(row.id, problem) }
    if (statuses.some((s) => s.code === "IN_PROGRESS")) return { next: "wait" }

    if (row.mediaType !== "CAROUSEL") return publishOnce(row, containers.items[0], deps, signal)
    if (!containers.carousel) {
      const carousel = await client.createContainer({ kind: "carousel", children: containers.items, caption: row.caption || undefined, aiGenerated: containers.aiGenerated }, signal)
      await prisma.instagramPublish.update({ where: { id: row.id }, data: { containerIds: asJson({ ...containers, carousel }) } })
      return { next: "again" }
    }
    const status = await client.containerStatus(containers.carousel, signal)
    if (status.code === "PUBLISHED") return { done: await reconcile(row, deps, signal) }
    const carouselProblem = containerProblem([status], false)
    if (carouselProblem) return { done: await failRow(row.id, carouselProblem) }
    if (status.code === "IN_PROGRESS") return { next: "wait" }
    return publishOnce(row, containers.carousel, deps, signal)
  }

  // publishing: a publish call was made. Check the container before anything else
  const creation = containers.carousel ?? containers.items[0]
  if (!creation) return { done: await failRow(row.id, "Its Instagram container is missing, so it can't be checked. Look on Instagram before posting it again.") }
  const status = await client.containerStatus(creation, signal)
  if (status.code === "PUBLISHED") return { done: await reconcile(row, deps, signal) }
  const problem = containerProblem([status], false)
  if (problem) return { done: await failRow(row.id, problem) }
  if (status.code === "IN_PROGRESS") return { next: "wait" }
  // FINISHED: the last call didn't take, or hasn't shown yet. Give it time, look for the post, then try again
  const attempt = containers.publishAttemptAt ? new Date(containers.publishAttemptAt).getTime() : 0
  if (deps.now().getTime() - attempt < SETTLE_MS) return { next: "wait" }
  const found = await findPost(row, deps, signal)
  if (found) return { done: await markPublished(row, deps, { mediaId: found.id, permalink: found.permalink }, signal) }
  return publishOnce(row, creation, deps, signal)
}

/** Why these containers can't be posted (an error or an expiry), or null */
function containerProblem(statuses: { code: ContainerStatus; detail: string | null }[], carouselItems: boolean): string | null {
  const error = statuses.findIndex((s) => s.code === "ERROR")
  if (error !== -1) {
    const detail = statuses[error].detail ? ` (${statuses[error].detail})` : ""
    return `Instagram couldn't use ${carouselItems ? `slide ${error + 1}` : "the image"}${detail}, so nothing was posted.`
  }
  if (statuses.some((s) => s.code === "EXPIRED")) return "Instagram's copy expired (after 24 hours) before it went out, so nothing was posted. Ask again to post it."
  return null
}

/** One media_publish call, with the row marked "publishing" first so nobody calls it again without checking */
async function publishOnce(row: InstagramPublish, creation: string, deps: PublishDeps, signal?: AbortSignal): Promise<Step> {
  const quota = await deps.client.quota(signal)
  if (quota.used >= quota.total) return { done: await failRow(row.id, `Instagram's limit of ${quota.total} API posts a day was used up before it could go out, so nothing was posted. Ask again tomorrow.`) }

  const containers = readContainers(row.containerIds)
  const { count } = await prisma.instagramPublish.updateMany({
    where: { id: row.id, status: { in: ["containers", "publishing"] } },
    data: { status: "publishing", containerIds: asJson({ ...containers, publishAttemptAt: deps.now().toISOString() }) },
  })
  if (!count) return { next: "again" }

  try {
    const published = await deps.client.publish(creation, signal)
    return { done: await markPublished(row, deps, { mediaId: published.id, partial: published.partial }, signal) }
  } catch (error) {
    if (isNotReady(error)) {
      await prisma.instagramPublish.updateMany({ where: { id: row.id, status: "publishing" }, data: { status: "containers" } })
      return { next: "wait" }
    }
    if (isLimitReached(error)) return { done: await failRow(row.id, `Instagram's daily publishing limit was reached, so nothing was posted. Ask again tomorrow. (${message(error)})`) }
    // No answer, or Instagram's own trouble: it may have gone out. The next look checks before trying again
    if (isTransient(error)) return { next: "wait" }
    const status = await deps.client.containerStatus(creation, signal).catch(() => null)
    if (status?.code === "PUBLISHED") return { done: await reconcile(row, deps, signal) }
    return { done: await failRow(row.id, `Instagram refused the post, so nothing was posted: ${message(error)}`) }
  }
}

/** The post a publish call made when its answer was lost: the newest feed post with this caption since the call (stories aren't listed) */
async function findPost(row: InstagramPublish, deps: PublishDeps, signal?: AbortSignal): Promise<{ id: string; permalink: string | null } | null> {
  if (row.mediaType === "STORIES") return null
  const attempt = readContainers(row.containerIds).publishAttemptAt
  const since = (attempt ? new Date(attempt) : row.createdAt).getTime() - 120_000
  const recent = await deps.client.recentMedia(10, signal).catch(() => [])
  const match = recent.find((m) => (m.caption ?? "").trim() === row.caption.trim() && (!m.timestamp || Date.parse(m.timestamp.replace(/\+0000$/, "Z")) >= since))
  return match ? { id: match.id, permalink: match.permalink } : null
}

/** Instagram says it's published: record the post, or that its link couldn't be found */
async function reconcile(row: InstagramPublish, deps: PublishDeps, signal?: AbortSignal): Promise<InstagramPublish> {
  const found = await findPost(row, deps, signal)
  if (found) return markPublished(row, deps, { mediaId: found.id, permalink: found.permalink }, signal)
  return finish(row.id, { status: "published", error: "Instagram shows it as posted, but its link couldn't be found here; check the account." })
}

async function markPublished(row: InstagramPublish, deps: PublishDeps, post: { mediaId: string; permalink?: string | null; partial?: string | null }, signal?: AbortSignal): Promise<InstagramPublish> {
  const permalink = post.permalink ?? (await deps.client.media(post.mediaId, signal).then((m) => m.permalink, () => null))
  const note = post.partial ? `It's live, but Instagram reported ${post.partial.toLowerCase().replace(/_/g, " ")}; check the post.` : null
  return finish(row.id, { status: "published", igMediaId: post.mediaId, permalink, error: note })
}

function failRow(id: string, text: string): Promise<InstagramPublish> {
  return finish(id, { status: "failed", error: text })
}

/** Ends a row, published or failed, and lets it go; its error is redacted */
function finish(id: string, data: { status: "published" | "failed"; error?: string | null; igMediaId?: string; permalink?: string | null }): Promise<InstagramPublish> {
  return prisma.instagramPublish.update({ where: { id }, data: { ...data, error: data.error ? redactSecrets(data.error).slice(0, 1_000) : null, claimedAt: null } })
}

function message(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 400)
}

/** One audit entry per publish, by the approving officer, with how it stood when the apply finished */
async function auditPublish(id: string, input: StartPublish) {
  const row = await prisma.instagramPublish.findUnique({ where: { id } })
  if (!row) return
  await createAuditLog({
    actorUserId: input.approvedById,
    actionType: "CREATE",
    entityType: "INSTAGRAM_PUBLISH",
    entityId: row.id,
    summary: describePublish(row, input.deck.title),
    after: { deckId: row.deckId, version: row.version, slideIds: row.slideIds, mediaType: row.mediaType, caption: row.caption, aiGenerated: readContainers(row.containerIds).aiGenerated, status: row.status, igMediaId: row.igMediaId, permalink: row.permalink, error: row.error },
    metadata: { ...input.auditMetadata, publishId: row.id },
  })
}

/** The room a publish belongs to: its proposal's, else its deck's */
async function publishRoom(row: Pick<InstagramPublish, "proposalId" | "deckId">): Promise<string | null> {
  if (row.proposalId) {
    const proposal = await prisma.jackProposal.findUnique({ where: { id: row.proposalId }, select: { roomId: true } })
    if (proposal) return proposal.roomId
  }
  if (!row.deckId) return null
  return (await prisma.jackDeck.findUnique({ where: { id: row.deckId }, select: { roomId: true } }))?.roomId ?? null
}

/** A room note saying how a waiting post ended (the job and "Check now"), so the room and Jack's history carry it */
export async function notePublishOutcome(row: InstagramPublish): Promise<void> {
  try {
    const roomId = await publishRoom(row)
    if (!roomId) return
    const deck = row.deckId ? await prisma.jackDeck.findUnique({ where: { id: row.deckId }, select: { title: true } }) : null
    const note = await prisma.jackMessage.create({ data: { roomId, kind: "system", content: `${describePublish(row, deck?.title ?? "a deleted deck")} → ${PUBLISH_HISTORY}` }, include: jackMessageInclude })
    await broadcastRoomEvent(roomId, { type: JACK_EVENT.created, message: toMessageView(note) })
  } catch (error) {
    console.error(`[jack] Couldn't post the Instagram outcome note for ${row.id}:`, error)
  }
}

/**
 * The finish job's work, and "Check now" (`ids`): every post still on its way that nobody holds, oldest
 * first, moved along with a short wait each. A row left queued by a function that died fails (nothing
 * went out).
 */
export async function finishInstagramPublishes(
  deps: PublishDeps,
  { deadline, signal, ids, waitMs = 20_000 }: { deadline: number; signal?: AbortSignal; ids?: string[]; waitMs?: number },
): Promise<{ published: number; failed: number; waiting: number; busy: number; errors: string[] }> {
  const rows = await prisma.instagramPublish.findMany({
    where: { status: { in: ACTIVE_STATUSES }, ...(ids ? { id: { in: ids } } : {}) },
    orderBy: { createdAt: "asc" },
    take: 10,
    select: { id: true },
  })
  const counts = { published: 0, failed: 0, waiting: 0, busy: 0, errors: [] as string[] }
  for (const { id } of rows) {
    if (signal?.aborted || deps.now().getTime() > deadline - 10_000) break
    if (!(await claimPublish(id, deps.now()))) {
      counts.busy++
      continue
    }
    let row: InstagramPublish
    try {
      row = await advanceInstagramPublish(id, deps, { until: Math.min(deadline - 10_000, deps.now().getTime() + waitMs), signal, notify: true })
    } catch (error) {
      row = await noteCheckFailed(id, error)
      counts.errors.push(message(error))
    }
    if (row.status === "published") counts.published++
    else if (row.status === "failed") counts.failed++
    else counts.waiting++
  }
  return counts
}
