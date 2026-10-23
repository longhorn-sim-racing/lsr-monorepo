import { slideImageUrl } from "@/lib/jack/decks"
import { roomMessageUrl } from "@/lib/jack/proposals"
import { ACTIVE_STATUSES, isPublishStatus, type PublishMediaType, type PublishStatus } from "@/lib/jack/publish"
import { prisma } from "@/server/db"

/**
 * The publish history for Content → Instagram (#188, design §13): every post officers approved from a
 * deck, newest first, with what it posted, how it went, who asked and who approved, and where it came
 * from (the room card, or the deck page). Nothing here calls Instagram.
 */

export type PublishHistoryRow = {
  id: string
  createdAt: Date
  updatedAt: Date
  mediaType: PublishMediaType
  slides: number
  caption: string
  status: PublishStatus
  /** Why it failed, or a note on a post that's up (redacted when stored) */
  error: string | null
  permalink: string | null
  aiGenerated: boolean
  deck: { id: string; title: string; version: number | null } | null
  /** The first slide's thumbnail (officer-only route), or its public copy when the deck is gone */
  thumbUrl: string | null
  createdByName: string | null
  approvedByName: string | null
  /** The room card it was approved on, or null for the deck page's button */
  proposalUrl: string | null
}

export async function listPublishes({ limit = 30 }: { limit?: number } = {}): Promise<PublishHistoryRow[]> {
  const rows = await prisma.instagramPublish.findMany({ orderBy: { createdAt: "desc" }, take: limit })
  if (!rows.length) return []
  const deckIds = [...new Set(rows.flatMap((r) => (r.deckId ? [r.deckId] : [])))]
  const userIds = [...new Set(rows.flatMap((r) => [r.createdById, r.approvedById]).filter((id): id is string => Boolean(id)))]
  const proposalIds = rows.flatMap((r) => (r.proposalId ? [r.proposalId] : []))
  const [decks, users, proposals] = await Promise.all([
    deckIds.length ? prisma.jackDeck.findMany({ where: { id: { in: deckIds } }, select: { id: true, title: true } }) : [],
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } }) : [],
    proposalIds.length ? prisma.jackProposal.findMany({ where: { id: { in: proposalIds } }, select: { id: true, roomId: true, messageId: true } }) : [],
  ])
  const deckOf = new Map(decks.map((d) => [d.id, d]))
  const nameOf = new Map(users.map((u) => [u.id, u.displayName]))
  const proposalOf = new Map(proposals.map((p) => [p.id, p]))
  const name = (id: string | null) => (id ? (nameOf.get(id) ?? "A former officer") : null)

  return rows.map((row) => {
    const deck = row.deckId ? deckOf.get(row.deckId) : undefined
    const proposal = row.proposalId ? proposalOf.get(row.proposalId) : undefined
    const containers = row.containerIds && typeof row.containerIds === "object" && !Array.isArray(row.containerIds) ? (row.containerIds as Record<string, unknown>) : {}
    return {
      id: row.id,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      mediaType: row.mediaType as PublishMediaType,
      slides: row.slideIds.length,
      caption: row.caption,
      status: isPublishStatus(row.status) ? row.status : "failed",
      error: row.error,
      permalink: row.permalink,
      aiGenerated: containers.aiGenerated === true,
      deck: deck ? { id: deck.id, title: deck.title, version: row.version } : null,
      thumbUrl: deck && row.version && row.slideIds[0] ? slideImageUrl(deck.id, row.version, row.slideIds[0], "thumb") : (row.imageUrls[0] ?? null),
      createdByName: name(row.createdById),
      approvedByName: name(row.approvedById),
      proposalUrl: proposal ? roomMessageUrl(proposal.roomId, proposal.messageId) : null,
    }
  })
}

/** Posts still on their way to Instagram */
export function countWaitingPublishes(): Promise<number> {
  return prisma.instagramPublish.count({ where: { status: { in: ACTIVE_STATUSES } } })
}

/** Whether the follow-up job that finishes waiting posts is switched on */
export async function publishFollowUpOn(): Promise<boolean> {
  const job = await prisma.scheduledJob.findUnique({ where: { key: "instagram-publish.finish" }, select: { enabled: true } })
  return job?.enabled ?? false
}
