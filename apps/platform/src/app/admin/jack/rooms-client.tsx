"use client"

import { useRouter } from "next/navigation"
import { JackRoomList } from "@/components/jack/room-list"
import { unexpectedError } from "@/lib/action-result"
import type { JackSpend } from "@/lib/jack/spend"
import type { JackRoomSummary } from "@/lib/jack/types"
import { createJackRoom } from "./actions"

export function JackRoomsClient({ rooms, spend }: { rooms: JackRoomSummary[]; spend: JackSpend | null }) {
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

  return <JackRoomList rooms={rooms} spend={spend} onCreate={create} />
}
