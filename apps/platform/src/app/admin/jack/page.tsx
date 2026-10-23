import { requireOfficerPage } from "@/server/auth/guards"
import { roomSearchQuery, searchRooms } from "@/server/jack/room-search"
import { listRooms } from "@/server/jack/rooms"
import { getMonthSpend } from "@/server/jack/spend"
import { JackRoomsClient } from "./rooms-client"

export const dynamic = "force-dynamic"

export const metadata = { title: "Jack" }

export default async function AdminJackPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  await requireOfficerPage()
  const query = roomSearchQuery((await searchParams).q)
  const [rooms, spend, search] = await Promise.all([
    listRooms(),
    getMonthSpend().catch((error) => {
      console.error("[jack] Couldn't load this month's spend:", error)
      return null
    }),
    query ? searchRooms(query) : null,
  ])
  return <JackRoomsClient rooms={rooms} spend={spend} search={search} />
}
