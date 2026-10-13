import { requireOfficerPage } from "@/server/auth/guards"
import { listRooms } from "@/server/jack/rooms"
import { getMonthSpend } from "@/server/jack/spend"
import { JackRoomsClient } from "./rooms-client"

export const dynamic = "force-dynamic"

export const metadata = { title: "Jack" }

export default async function AdminJackPage() {
  await requireOfficerPage()
  const [rooms, spend] = await Promise.all([
    listRooms(),
    getMonthSpend().catch((error) => {
      console.error("[jack] Couldn't load this month's spend:", error)
      return null
    }),
  ])
  return <JackRoomsClient rooms={rooms} spend={spend} />
}
