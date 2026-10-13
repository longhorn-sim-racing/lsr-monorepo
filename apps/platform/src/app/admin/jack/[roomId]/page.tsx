import { notFound } from "next/navigation"
import { requireOfficerPage } from "@/server/auth/guards"
import { getRoomSnapshot } from "@/server/jack/rooms"
import { jackRoomIdSchema } from "@/schemas/jack.schema"
import { JackRoomClient } from "./room-client"

export const dynamic = "force-dynamic"
// Posting a message answers it after the response, in this route's function (Server Actions run
// with their page's config). The placeholder takes ~3 s; raise this for model replies (300 needs
// Fluid compute on the Hobby plan)
export const maxDuration = 60

type JackRoomPageArgs = {
  params: Promise<{ roomId: string }>
}

export default async function JackRoomPage({ params }: JackRoomPageArgs) {
  const officer = await requireOfficerPage()
  const { roomId } = await params
  if (!jackRoomIdSchema.safeParse(roomId).success) notFound()

  const snapshot = await getRoomSnapshot(roomId)
  if (!snapshot) notFound()

  return <JackRoomClient initial={snapshot} me={{ userId: officer.id, displayName: officer.displayName }} />
}
