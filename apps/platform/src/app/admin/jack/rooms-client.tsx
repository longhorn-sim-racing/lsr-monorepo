"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { RowMenu, type RowMenuItem } from "@/components/admin/kit"
import { JackRoomList, type RoomListView } from "@/components/jack/room-list"
import { RoomSearch } from "@/components/jack/room-search"
import { unexpectedError } from "@/lib/action-result"
import type { JackSpend } from "@/lib/jack/spend"
import { jackRoomTitle, type JackRoomSummary } from "@/lib/jack/types"
import type { RoomSearchResult } from "@/server/jack/room-search"
import { createJackRoom } from "./actions"
import { archiveJackRoom, pinJackRoom } from "./room-actions"

type JackRoomsClientProps = {
  rooms: JackRoomSummary[]
  spend: JackSpend | null
  search: RoomSearchResult | null
  view: RoomListView
  archivedCount: number
}

export function JackRoomsClient({ rooms, spend, search, view, archivedCount }: JackRoomsClientProps) {
  const router = useRouter()
  const [, startTransition] = useTransition()

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

  /** Runs a room change from its menu, then shows the list as it now is */
  async function change(run: () => Promise<{ ok: boolean; error?: string }>, done: string, failed: string) {
    try {
      const result = await run()
      if (!result.ok) return void toast.error(result.error ?? failed)
      toast.success(done)
      startTransition(() => router.refresh())
    } catch (error) {
      toast.error(unexpectedError(error, failed))
    }
  }

  function rowMenu(room: JackRoomSummary) {
    const name = jackRoomTitle(room)
    const items: RowMenuItem[] = room.archivedAt
      ? [{ label: "Unarchive", onSelect: () => change(() => archiveJackRoom(room.id, false), `Unarchived “${name}”`, "Couldn't unarchive it") }]
      : [
          room.pinnedAt
            ? { label: "Unpin", onSelect: () => change(() => pinJackRoom(room.id, false), `Unpinned “${name}”`, "Couldn't unpin it") }
            : { label: "Pin to the top", onSelect: () => change(() => pinJackRoom(room.id, true), `Pinned “${name}”`, "Couldn't pin it") },
          { label: "Archive", onSelect: () => change(() => archiveJackRoom(room.id, true), `Archived “${name}”`, "Couldn't archive it") },
        ]
    return <RowMenu label={`Options for ${name}`} items={items} />
  }

  return (
    <JackRoomList
      rooms={rooms}
      spend={spend}
      onCreate={create}
      search={<RoomSearch result={search} />}
      view={view}
      archivedCount={archivedCount}
      onView={(next) => startTransition(() => router.push(next === "archived" ? "/admin/jack?view=archived" : "/admin/jack"))}
      rowMenu={rowMenu}
    />
  )
}
