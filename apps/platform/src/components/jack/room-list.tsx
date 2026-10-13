"use client"

import Link from "next/link"
import { useState } from "react"
import { jackRoomTitle, type JackRoomSummary } from "@/lib/jack/types"

/*
 * The rooms list, drawn plainly on purpose (it gets restyled later). It renders what it's given and
 * reports what the officer does; the page wires up the actions.
 */

type RoomListProps = {
  rooms: JackRoomSummary[]
  /** Resolves with an error to show, or null once the room is open */
  onCreate: (title: string) => Promise<string | null>
}

export function JackRoomList({ rooms, onCreate }: RoomListProps) {
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold">Jack</h1>
        <p className="text-sm">Shared rooms for asking Jack about club data. Every officer sees every room.</p>
      </div>
      <NewRoomForm onCreate={onCreate} />
      {rooms.length ? (
        <ul className="flex flex-col gap-2">
          {rooms.map((room) => (
            <li key={room.id} className="rounded border p-3">
              <Link href={`/admin/jack/${room.id}`} className="font-semibold underline">
                {jackRoomTitle(room)}
              </Link>
              <p className="text-sm">
                {room.createdByName ? `Opened by ${room.createdByName}, ` : null}
                last active {new Date(room.updatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm">No rooms yet.</p>
      )}
    </div>
  )
}

function NewRoomForm({ onCreate }: { onCreate: RoomListProps["onCreate"] }) {
  const [title, setTitle] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault()
        if (creating) return
        setCreating(true)
        setError(null)
        const problem = await onCreate(title)
        setCreating(false)
        if (problem) setError(problem)
      }}
    >
      <label className="flex flex-col text-sm">
        Title (optional)
        <input className="rounded border p-1" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
      </label>
      <button type="submit" className="rounded border px-3 py-1" disabled={creating}>
        {creating ? "Opening..." : "New room"}
      </button>
      {error ? <p className="w-full text-sm text-red-600">{error}</p> : null}
    </form>
  )
}
