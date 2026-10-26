import { requireOfficerPage } from "@/server/auth/guards"
import { roomSearchQuery, searchRooms } from "@/server/jack/room-search"
import { countArchivedRooms, listRooms } from "@/server/jack/rooms"
import { getMonthSpend } from "@/server/jack/spend"
import { JackRoomsClient } from "./rooms-client"

export const dynamic = "force-dynamic"

export const metadata = { title: "Jack" }

type JackPageArgs = {
  /** q: the search box; view=archived: the archived rooms instead of the ones in use */
  searchParams: Promise<{ q?: string | string[]; view?: string | string[] }>
}

export default async function AdminJackPage({ searchParams }: JackPageArgs) {
  await requireOfficerPage()
  const params = await searchParams
  const query = roomSearchQuery(params.q)
  const view = (Array.isArray(params.view) ? params.view[0] : params.view) === "archived" ? "archived" : "active"
  const [rooms, archivedCount, spend, search] = await Promise.all([
    listRooms({ archived: view === "archived" }),
    countArchivedRooms(),
    getMonthSpend().catch((error) => {
      console.error("[jack] Couldn't load this month's spend:", error)
      return null
    }),
    query ? searchRooms(query) : null,
  ])
  return <JackRoomsClient rooms={rooms} spend={spend} search={search} view={view} archivedCount={archivedCount} />
}
