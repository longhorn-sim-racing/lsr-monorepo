"use client"

import { useRouter } from "next/navigation"
import { JackRoomList } from "@/components/jack/room-list"
import { RoomSearch } from "@/components/jack/room-search"
import { unexpectedError } from "@/lib/action-result"
import type { JackSpend } from "@/lib/jack/spend"
import type { JackRoomSummary } from "@/lib/jack/types"
import type { RoomSearchResult } from "@/server/jack/room-search"
import { createJackRoom } from "./actions"

export function JackRoomsClient({ rooms, spend, search }: { rooms: JackRoomSummary[]; spend: JackSpend | null; search: RoomSearchResult | null }) {
  const router = useRouter()

  async function create(title: string) {
    const formData = new FormData()
    formData.set("title", title)
    try {
      const result = await createJackRoom(formData)
      if (!result.ok) return result.error
      router.push(`/admin/jack/${result.data.roomId}`)
      return null
    } catch (error) {
      return unexpectedError(error, "Couldn't open a room")
    }
  }

  return <JackRoomList rooms={rooms} spend={spend} onCreate={create} search={<RoomSearch result={search} />} />
}
