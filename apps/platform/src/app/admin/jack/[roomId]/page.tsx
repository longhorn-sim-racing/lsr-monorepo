import { notFound } from "next/navigation"
import { requireOfficerPage } from "@/server/auth/guards"
import { getRoomSnapshot, listRooms } from "@/server/jack/rooms"
import { getMonthSpend } from "@/server/jack/spend"
import { jackRoomIdSchema } from "@/schemas/jack.schema"
import { JackRoomClient } from "./room-client"

export const metadata = { title: "Jack" }

export const dynamic = "force-dynamic"
// Posting a message answers it after the response, in this route's function (Server Actions run
// with their page's config), so this covers the whole reply loop: a reply with tool calls can take a
// minute or two (each one wraps up after 150 s), and messages posted meanwhile are answered in the
// same run. 300 s is the Fluid compute default and the most the Hobby plan allows (Pro allows 800);
// keep it under the room lock's 10-minute stale time (room-lock.ts).
export const maxDuration = 300

type JackRoomPageArgs = {
  params: Promise<{ roomId: string }>
}

export default async function JackRoomPage({ params }: JackRoomPageArgs) {
  const officer = await requireOfficerPage()
  const { roomId } = await params
  if (!jackRoomIdSchema.safeParse(roomId).success) notFound()

  const [snapshot, rooms, spend] = await Promise.all([
    getRoomSnapshot(roomId),
    listRooms(),
    getMonthSpend().catch((error) => {
      console.error("[jack] Couldn't load this month's spend:", error)
      return null
    }),
  ])
  if (!snapshot) notFound()

  return <JackRoomClient initial={snapshot} rooms={rooms} spend={spend} me={{ userId: officer.id, displayName: officer.displayName }} />
}
