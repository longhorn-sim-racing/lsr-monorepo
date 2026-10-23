"use client"

import Link from "next/link"
import { Search } from "lucide-react"
import { Badge, Button, EmptyState, Input, Panel, PanelHeader } from "@/components/admin/kit"
import { jackRoomTitle } from "@/lib/jack/types"
import type { RoomSearchResult } from "@/server/jack/room-search"
import { formatRoomTime } from "./room-list"

/*
 * The search box on the rooms list and what it found (#188): rooms by name and messages by their
 * words. A plain GET form, so a search is a link officers can share; each message opens in its room
 * with the messages around it.
 */

export const ROOM_SEARCH_INPUT_MAX = 200

export function RoomSearch({ result }: { result: RoomSearchResult | null }) {
  return (
    <div className="mb-4 flex flex-col gap-3">
      <form action="/admin/jack" method="get" role="search" className="flex flex-wrap items-center gap-2">
        <label htmlFor="jack-room-search" className="sr-only">
          Search rooms and messages
        </label>
        <div className="relative min-w-0 flex-[1_1_240px]">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-admin-subtle" />
          <Input
            id="jack-room-search"
            name="q"
            type="search"
            defaultValue={result?.query ?? ""}
            maxLength={ROOM_SEARCH_INPUT_MAX}
            placeholder="Search rooms and messages"
            // 16px on phones so iOS doesn't zoom in on focus
            className="pl-8 text-base md:text-[13px]"
          />
        </div>
        <Button type="submit">Search</Button>
        {result ? (
          <Button asChild variant="ghost">
            <Link href="/admin/jack">Clear</Link>
          </Button>
        ) : null}
      </form>
      {result ? <RoomSearchResults result={result} /> : null}
    </div>
  )
}

function RoomSearchResults({ result }: { result: RoomSearchResult }) {
  const { query, rooms, messages } = result
  const found = [rooms.length && `${rooms.length} ${rooms.length === 1 ? "room" : "rooms"}`, messages.length && `${messages.length} ${messages.length === 1 ? "message" : "messages"}`].filter(Boolean).join(" and ")
  return (
    <Panel aria-live="polite">
      <PanelHeader title={`Results for “${query}”`} description={found ? `${found}, best matches first` : undefined} />
      {!rooms.length && !messages.length ? (
        <EmptyState title="Nothing matches" description="Messages match whole words (and their endings); room names match any part." />
      ) : null}
      {rooms.length ? (
        <ul aria-label="Rooms">
          {rooms.map((room) => (
            <li key={room.id} className="border-b border-admin-row last:border-b-0">
              <Link href={`/admin/jack/${room.id}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 px-4 py-2.5 hover:bg-admin-surface">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate font-semibold">{jackRoomTitle(room)}</span>
                  {room.archivedAt ? <Badge tone="neutral">Archived</Badge> : null}
                </span>
                <span className="text-xs text-admin-subtle">Room · {formatRoomTime(room.updatedAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {messages.length ? (
        <ul aria-label="Messages" className={rooms.length ? "border-t border-admin-row" : undefined}>
          {messages.map((message) => (
            <li key={message.id} className="border-b border-admin-row last:border-b-0">
              <Link href={message.href} className="flex min-w-0 flex-col gap-0.5 px-4 py-2.5 hover:bg-admin-surface">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-admin-subtle">
                  <span className="min-w-0 truncate font-semibold text-foreground">{message.roomTitle}</span>
                  <span>
                    {message.author} · {formatRoomTime(message.createdAt)}
                  </span>
                  {message.kind === "assistant" ? <Badge tone="neutral">Answer</Badge> : null}
                  {message.roomArchived ? <Badge tone="neutral">Archived room</Badge> : null}
                </span>
                {message.snippet ? <span className="line-clamp-2 break-words text-[13px] text-muted-foreground">{message.snippet}</span> : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  )
}
