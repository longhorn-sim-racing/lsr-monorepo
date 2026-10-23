import { notFound } from "next/navigation"
import { JACK_DECK_SIZES } from "@/lib/jack/decks"
import { requireOfficerPage } from "@/server/auth/guards"
import { prisma } from "@/server/db"
import { getDeck, listDeckVersions } from "@/server/jack/decks/service"
import { deckPublishOptions } from "@/server/jack/publish/deck-options"
import { JackDeckClient } from "./deck-client"

export const dynamic = "force-dynamic"

export const metadata = { title: "Deck · Jack" }

const UUID = /^[0-9a-f-]{36}$/i

type JackDeckPageArgs = {
  params: Promise<{ deckId: string }>
  searchParams: Promise<{ v?: string }>
}

/** One of Jack's decks or graphics (#177): every slide, its notes, the versions, downloads, and Publish to Instagram and Add to gallery (#188) */
export default async function JackDeckPage({ params, searchParams }: JackDeckPageArgs) {
  await requireOfficerPage()
  const { deckId } = await params
  const { v } = await searchParams
  if (!UUID.test(deckId)) notFound()

  const current = await getDeck(deckId)
  if (!current) notFound()
  const asked = Number(v)
  const version = Number.isInteger(asked) && asked >= 1 && asked <= current.version ? asked : current.version
  const deck = version === current.version ? current : await getDeck(deckId, version)
  if (!deck) notFound()

  const [versions, room, createdBy, publish] = await Promise.all([
    listDeckVersions(deckId, 100),
    current.roomId ? prisma.jackRoom.findUnique({ where: { id: current.roomId }, select: { id: true, title: true } }) : null,
    current.createdById ? prisma.user.findUnique({ where: { id: current.createdById }, select: { displayName: true } }) : null,
    deckPublishOptions(current),
  ])
  // What Jack's replies that changed this deck cost (the whole reply, data lookups included)
  const messageIds = [...new Set(versions.flatMap((ver) => (ver.messageId ? [ver.messageId] : [])))]
  const spent = messageIds.length ? await prisma.jackMessage.aggregate({ where: { id: { in: messageIds } }, _sum: { costUsd: true } }) : null

  return (
    <JackDeckClient
      deck={{
        id: deck.id,
        title: current.title,
        size: deck.size,
        sizeLabel: JACK_DECK_SIZES[deck.size].label,
        version: deck.version,
        currentVersion: current.version,
        slides: deck.content.slides.map((slide) => ({ id: slide.id, notes: slide.notes ?? null })),
        createdAt: current.createdAt.toISOString(),
        updatedAt: current.updatedAt.toISOString(),
        createdByName: createdBy?.displayName ?? null,
        room: room ? { id: room.id, title: room.title ?? "Untitled room" } : null,
        costUsd: spent?._sum.costUsd ? Number(spent._sum.costUsd) : null,
      }}
      versions={versions.map((ver) => ({ version: ver.version, summary: ver.summary, slides: ver.slides, createdAt: ver.createdAt.toISOString(), byName: ver.byName }))}
      publish={publish}
    />
  )
}
