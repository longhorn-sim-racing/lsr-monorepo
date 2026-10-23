import { notFound } from "next/navigation"
import { requireOfficerPage } from "@/server/auth/guards"
import { getRoomSnapshot, listRooms } from "@/server/jack/rooms"
import { getMonthSpend } from "@/server/jack/spend"
import { jackRoomIdSchema } from "@/schemas/jack.schema"
import { JackRoomClient } from "./room-client"

export const metadata = { title: "Jack" }

export const dynamic = "force-dynamic"
// Posting a message (or asking Jack to continue) answers after the response, in this route's function
// (Server Actions run with their page's config), so this covers the whole reply loop. A run stops
// itself 280 s in and starts no answer with less than 150 s left (RUN_TIMING in reply-loop.ts); what's
// still waiting then gets a "continue" button. 300 s is the Fluid compute default and the most the
// Hobby plan allows (Pro allows 800). If this changes, change RUN_TIMING with it, and keep it under the
// room lock's 6-minute stale time (lib/jack/timing.ts).
export const maxDuration = 300

type JackRoomPageArgs = {
  params: Promise<{ roomId: string }>
  /** m: a message to open the room at (search results link here) */
  searchParams: Promise<{ m?: string | string[] }>
}

export default async function JackRoomPage({ params, searchParams }: JackRoomPageArgs) {
  const officer = await requireOfficerPage()
  const { roomId } = await params
  if (!jackRoomIdSchema.safeParse(roomId).success) notFound()
  const { m } = await searchParams
  const anchor = jackRoomIdSchema.safeParse(Array.isArray(m) ? m[0] : m)
  const anchorId = anchor.success ? anchor.data : undefined

  const [snapshot, rooms, spend] = await Promise.all([
    // Archived rooms open too, read-only (with ?m= links from search still landing on their message)
    getRoomSnapshot(roomId, { around: anchorId, viewerId: officer.id }),
    listRooms(),
    getMonthSpend().catch((error) => {
      console.error("[jack] Couldn't load this month's spend:", error)
      return null
    }),
  ])
  if (!snapshot) notFound()
  const { gap, feedback, ...initial } = snapshot
  const openAt = anchorId && snapshot.messages.some((message) => message.id === anchorId) ? anchorId : undefined

  return (
    <JackRoomClient
      // A new ?m= (or none: "jump to latest") starts the room over from its own snapshot
      key={openAt ?? "latest"}
      initial={initial}
      rooms={rooms}
      spend={spend}
      me={{ userId: officer.id, displayName: officer.displayName, avatarUrl: officer.avatarUrl }}
      anchorId={openAt}
      gap={gap}
      feedback={feedback}
    />
  )
}
