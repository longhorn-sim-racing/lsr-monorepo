"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { ChevronLeft } from "lucide-react"
import { Button, Notice, Select, Textarea } from "@/components/admin/kit"
import { cn } from "@/lib/utils"
import {
  JACK_PERSONA_NAME,
  type JackMessageView,
  type JackPersonaKey,
  type JackPresence,
  type JackRoomPersonaKey,
  type JackRoomSummary,
} from "@/lib/jack/types"
import { JackRoomRail } from "./room-list"
import type { JackConnection } from "./use-jack-room"

/*
 * Jack's room: these components only render what they're given and report what the officer does. The
 * live logic is in use-jack-room.ts.
 */

type RoomViewProps = {
  roomId: string
  title: string
  persona: JackRoomPersonaKey
  messages: JackMessageView[]
  present: JackPresence[]
  connection: JackConnection
  /** Every room, for the rail beside this one */
  rooms: JackRoomSummary[]
  /** Resolves with an error to show, or null once the message is posted */
  onSend: (content: string) => Promise<string | null>
  /** Resolves with an error to show, or null once switched */
  onSwitchPersona: (persona: JackRoomPersonaKey) => Promise<string | null>
}

export function JackRoomView({ roomId, title, persona, messages, present, connection, rooms, onSend, onSwitchPersona }: RoomViewProps) {
  return (
    // Fills the workspace below the top bar so the conversation scrolls and the composer stays put
    <div className="-mx-4 -my-4 flex h-[calc(100dvh-44px)] bg-card md:-mx-6 md:-my-5">
      <JackRoomRail rooms={rooms} activeId={roomId} />
      <section aria-label={title} className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-admin-row px-4 py-2.5 md:px-5">
          <div className="flex min-w-0 flex-col">
            <Link href="/admin/jack" className="mb-0.5 inline-flex w-fit items-center gap-0.5 text-xs font-medium text-muted-foreground hover:text-foreground lg:hidden">
              <ChevronLeft className="size-3.5" aria-hidden />
              All rooms
            </Link>
            <h1 className="truncate font-display text-lg font-semibold leading-tight">{title}</h1>
            <ConnectionLine connection={connection} />
          </div>
          <div className="flex flex-wrap items-center gap-3.5">
            <PersonaSwitch persona={persona} onSwitch={onSwitchPersona} />
            <PresenceStack present={present} />
          </div>
        </header>
        <MessageList messages={messages} />
        <Composer persona={persona} onSend={onSend} />
      </section>
    </div>
  )
}

function ConnectionLine({ connection }: { connection: JackConnection }) {
  if (connection === "live")
    return (
      <span className="flex items-center gap-1.5 text-xs text-admin-subtle">
        <span aria-hidden className="size-1.5 rounded-full bg-tone-success-foreground" />
        Live
      </span>
    )
  if (connection === "connecting") return <span className="text-xs text-admin-subtle">Connecting</span>
  return <span className="text-xs font-medium text-tone-danger-foreground">Not connected. Reload the page to see new messages.</span>
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?"
}

function PresenceStack({ present }: { present: JackPresence[] }) {
  if (!present.length) return null
  const names = present.map((p) => p.displayName).join(", ")
  return (
    <div className="flex items-center gap-2" title={names}>
      <div className="flex" aria-hidden>
        {present.slice(0, 4).map((p, i) => (
          <span
            key={p.userId}
            className={cn("flex size-6 items-center justify-center rounded-full border-2 border-card bg-muted text-[10px] font-semibold text-tone-neutral-foreground", i > 0 && "-ml-1.5")}
          >
            {initials(p.displayName)}
          </span>
        ))}
      </div>
      <span className="text-xs text-muted-foreground">
        <span className="sr-only">In the room: {names}. </span>
        {present.length} here
      </span>
    </div>
  )
}

function PersonaSwitch({ persona, onSwitch }: { persona: JackRoomPersonaKey; onSwitch: RoomViewProps["onSwitchPersona"] }) {
  const [error, setError] = useState<string | null>(null)
  const [switching, setSwitching] = useState(false)

  async function pick(next: JackRoomPersonaKey) {
    if (switching || next === persona) return
    setSwitching(true)
    setError(null)
    const problem = await onSwitch(next)
    setSwitching(false)
    if (problem) setError(problem)
  }

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="jack-persona" className="text-xs text-muted-foreground">
        Answered by
      </label>
      <Select
        id="jack-persona"
        value={persona}
        disabled={switching}
        onChange={(e) => void pick(e.target.value as JackRoomPersonaKey)}
        className="h-7 w-auto text-xs font-semibold"
      >
        <option value="jack">Jack</option>
        <option value="lift">Lift (2× cost)</option>
      </Select>
      {error ? (
        <span role="alert" className="text-xs font-medium text-tone-danger-foreground">
          {error}
        </span>
      ) : null}
    </div>
  )
}

function PersonaAvatar({ persona }: { persona: JackPersonaKey }) {
  const styles: Record<JackPersonaKey, string> = {
    jack: "bg-primary text-primary-foreground",
    lift: "bg-admin-nav text-primary",
    stand: "bg-muted text-tone-neutral-foreground",
  }
  return (
    <span aria-hidden className={cn("flex size-7 shrink-0 items-center justify-center rounded-md font-display text-sm font-semibold", styles[persona])}>
      {JACK_PERSONA_NAME[persona][0]}
    </span>
  )
}

const timeOfDay = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" })

function MessageList({ messages }: { messages: JackMessageView[] }) {
  const end = useRef<HTMLDivElement>(null)
  const last = messages.at(-1)
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" })
  }, [messages.length, last?.content])

  if (!messages.length)
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
        <p className="text-sm font-semibold">No messages yet</p>
        <p className="max-w-sm text-[13px] text-muted-foreground">Ask Jack about events, members, LSC entries or payments. Everyone in the room sees the answer as it streams.</p>
      </div>
    )

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-5">
      <ol className="flex flex-col gap-4">
        {messages.map((message) => {
          if (message.author.kind === "system")
            return (
              <li key={message.id} className="flex items-center gap-2.5 text-xs text-admin-subtle">
                <span aria-hidden className="h-px flex-1 bg-admin-row" />
                <span>
                  {message.content} · {timeOfDay.format(new Date(message.createdAt))}
                </span>
                <span aria-hidden className="h-px flex-1 bg-admin-row" />
              </li>
            )
          const isModel = message.author.kind === "assistant"
          const name = message.author.kind === "assistant" ? JACK_PERSONA_NAME[message.author.persona] : message.author.displayName
          return (
            <li key={message.id} className="flex gap-3">
              {message.author.kind === "assistant" ? (
                <PersonaAvatar persona={message.author.persona} />
              ) : (
                <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-tone-neutral-foreground">
                  {initials(name)}
                </span>
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-[13px]">
                  <strong className="font-bold">{name}</strong>{" "}
                  <span className="text-xs text-admin-subtle">{message.status === "streaming" ? "answering" : timeOfDay.format(new Date(message.createdAt))}</span>
                </span>
                <p className={cn("max-w-3xl whitespace-pre-wrap break-words leading-relaxed", isModel && "text-foreground")}>
                  {message.content}
                  {message.status === "streaming" && <span aria-hidden className="ml-0.5 inline-block h-[15px] w-[7px] translate-y-0.5 bg-primary" />}
                </p>
                {message.status === "error" ? (
                  <Notice tone="warning" className="max-w-xl">
                    This answer stopped early. Ask again to retry.
                  </Notice>
                ) : null}
              </div>
            </li>
          )
        })}
      </ol>
      <div ref={end} />
    </div>
  )
}

function Composer({ persona, onSend }: { persona: JackRoomPersonaKey; onSend: RoomViewProps["onSend"] }) {
  const [content, setContent] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  async function send() {
    if (sending || !content.trim()) return
    setSending(true)
    setError(null)
    const problem = await onSend(content)
    setSending(false)
    if (problem) setError(problem)
    else setContent("")
  }

  return (
    <form
      className="flex flex-col gap-2 border-t border-admin-row px-4 pb-4 pt-3 md:px-5"
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
    >
      <label htmlFor="jack-message" className="sr-only">
        Message the room
      </label>
      <Textarea
        id="jack-message"
        rows={2}
        value={content}
        placeholder={`Message the room. ${JACK_PERSONA_NAME[persona]} answers every message.`}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void send()
          }
        }}
        className="min-h-14 text-sm"
      />
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        {error ? (
          <p role="alert" className="text-xs font-medium text-tone-danger-foreground">
            {error}
          </p>
        ) : (
          <span className="text-xs text-admin-subtle">
            {persona === "lift" ? "Lift answers in this room until someone switches it back to Jack." : "Enter sends, Shift+Enter adds a line."}
          </span>
        )}
        <Button type="submit" variant="primary" pending={sending} disabled={!content.trim()}>
          Send
        </Button>
      </div>
    </form>
  )
}

