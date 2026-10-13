import { requireOfficerPage } from "@/server/auth/guards"
import { listRooms } from "@/server/jack/rooms"
import { JackRoomsClient } from "./rooms-client"

export const dynamic = "force-dynamic"

export const metadata = { title: "Jack" }

export default async function AdminJackPage() {
  await requireOfficerPage()
  const rooms = await listRooms()
  return <JackRoomsClient rooms={rooms} />
}
