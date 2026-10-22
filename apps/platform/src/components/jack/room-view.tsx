"use client"

import Link from "next/link"
import { memo, useEffect, useRef, useState } from "react"
import { ChevronLeft, Pencil } from "lucide-react"
import { Button, Input, Notice, Select, Textarea } from "@/components/admin/kit"
import { cn } from "@/lib/utils"
import {
  JACK_PERSONA_NAME,
  jackRoomTitle,
  type JackMessageView,
  type JackPresence,
  type JackRoomPersonaKey,
  type JackRoomSummary,
  type JackRoomView as JackRoomSettings,
} from "@/lib/jack/types"
import { replyPieces } from "@/lib/jack/reply-pieces"
import { JACK_TITLE_MAX } from "@/schemas/jack.schema"
import type { JackSpend } from "@/lib/jack/spend"
import { JackToolPartView } from "./parts/tool-part"
import { PersonaAvatar } from "./persona-avatar"
import { JackRoomRail } from "./room-list"
import { SpendMeter } from "./spend-meter"
import type { JackConnection, JackStall } from "./use-jack-room"

/*
 * Jack's room: these components only render what they're given and report what the officer does. The
 * live logic is in use-jack-room.ts.
 */

type RoomViewProps = {
  /** The room's live settings (title, persona) */
  room: JackRoomSettings
  messages: JackMessageView[]
  present: JackPresence[]
  connection: JackConnection
  /** Whether to offer asking Jack to continue, and why */
  stall: JackStall
  /** Every room, for the rail beside this one */
  rooms: JackRoomSummary[]
  /** This month's spend, as of page load */
  spend: JackSpend | null
  /** Resolves with an error to show, or null once the message is posted */
  onSend: (content: string) => Promise<string | null>
  /** Resolves with an error to show, or null once switched */
  onSwitchPersona: (persona: JackRoomPersonaKey) => Promise<string | null>
  /** Resolves with an error to show, or null once renamed */
  onRename: (title: string) => Promise<string | null>
  /** Resolves with an error to show, or null once a run is asked to start */
  onContinue: () => Promise<string | null>
}

export function JackRoomView({ room, messages, present, connection, stall, rooms, spend, onSend, onSwitchPersona, onRename, onContinue }: RoomViewProps) {
  const title = jackRoomTitle(room)
  // Bumped when this officer sends, so the list jumps to the end even if they'd scrolled up
  const [sentCount, setSentCount] = useState(0)

  async function send(content: string) {
    const problem = await onSend(content)
    if (!problem) setSentCount((n) => n + 1)
    return problem
  }

  return (
    // Fills the workspace below the top bar so the conversation scrolls and the composer stays put
    <div className="-mx-4 -my-4 flex h-[calc(100dvh-44px)] bg-card md:-mx-6 md:-my-5">
      {/* The open room's title and persona are live; the rest of the rail is as of page load */}
      <JackRoomRail rooms={rooms.map((r) => (r.id === room.id ? { ...r, title: room.title, persona: room.persona } : r))} activeId={room.id} />
      <section aria-label={title} className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-admin-row px-4 py-2.5 md:px-5">
          <div className="flex min-w-0 flex-col">
            <Link href="/admin/jack" className="mb-0.5 inline-flex w-fit items-center gap-0.5 text-xs font-medium text-muted-foreground hover:text-foreground lg:hidden">
              <ChevronLeft className="size-3.5" aria-hidden />
              All rooms
            </Link>
            <RoomTitle title={title} saved={room.title} onRename={onRename} />
            <span className="flex flex-wrap items-center gap-x-3">
              <ConnectionLine connection={connection} />
              {spend ? <SpendMeter spend={spend} /> : null}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3.5">
            <PersonaSwitch persona={room.persona} onSwitch={onSwitchPersona} />
            <PresenceStack present={present} />
          </div>
        </header>
        <MessageList messages={messages} followSignal={sentCount} />
        <AnswerStatus messages={messages} />
        {stall ? <ContinueBar stall={stall} name={stalledName(stall, messages, room.persona)} onContinue={onContinue} /> : null}
        <Composer persona={room.persona} onSend={send} />
      </section>
    </div>
  )
}

/** The room's name, with a pencil to rename it in place: Enter saves, Escape cancels */
function RoomTitle({ title, saved, onRename }: { title: string; saved: string | null; onRename: RoomViewProps["onRename"] }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const pencil = useRef<HTMLButtonElement>(null)
  // After Save, Cancel or Escape, focus goes back to the pencil instead of the page
  const refocus = useRef(false)

  useEffect(() => {
    if (!editing && refocus.current) {
      refocus.current = false
      pencil.current?.focus()
    }
  }, [editing])

  function stop() {
    refocus.current = true
    setEditing(false)
  }

  function start() {
    setDraft(saved ?? "")
    setError(null)
    setEditing(true)
  }

  async function save() {
    if (saving) return
    if (draft.trim() === (saved ?? "")) return stop()
    setSaving(true)
    setError(null)
    const problem = await onRename(draft)
    setSaving(false)
    if (problem) setError(problem)
    else stop()
  }

  if (!editing)
    return (
      <div className="group flex min-w-0 items-center gap-1">
        <h1 className="truncate font-display text-lg font-semibold leading-tight">{title}</h1>
        <button
          ref={pencil}
          type="button"
          onClick={start}
          aria-label="Rename room"
          title="Rename room"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-admin-subtle hover:bg-accent hover:text-foreground"
        >
          <Pencil className="size-3.5" aria-hidden />
        </button>
      </div>
    )

  return (
    <form
      className="flex min-w-0 flex-col gap-1"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <div className="flex items-center gap-1.5">
        <label htmlFor="jack-room-rename" className="sr-only">
          Room name
        </label>
        <Input
          id="jack-room-rename"
          autoFocus
          value={draft}
          maxLength={JACK_TITLE_MAX}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !saving) stop()
          }}
          // 16px on phones so iOS doesn't zoom in on focus
          className="h-8 w-64 max-w-full text-base font-semibold md:h-7 md:text-sm"
        />
        <Button type="submit" size="sm" variant="primary" pending={saving}>
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={stop} disabled={saving}>
          Cancel
        </Button>
      </div>
      {error ? (
        <span role="alert" className="text-xs font-medium text-tone-danger-foreground">
          {error}
        </span>
      ) : null}
    </form>
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
  return <span className="text-xs font-medium text-tone-danger-foreground">Not connected. Trying again; reload the page if this stays.</span>
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
            {p.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- officer avatars may be served from various hosts
              <img src={p.avatarUrl} alt="" className="size-full rounded-full object-cover" />
            ) : (
              initials(p.displayName)
            )}
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
  // What the officer picked, shown while the switch goes through so the select doesn't flick back
  const [pending, setPending] = useState<JackRoomPersonaKey | null>(null)

  async function pick(next: JackRoomPersonaKey) {
    if (pending || next === persona) return
    setPending(next)
    setError(null)
    const problem = await onSwitch(next)
    setPending(null)
    if (problem) setError(problem)
  }

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="jack-persona" className="text-xs text-muted-foreground">
        Answered by
      </label>
      <PersonaAvatar persona={pending ?? persona} className="size-7 md:size-6" />
      <Select
        id="jack-persona"
        value={pending ?? persona}
        disabled={pending !== null}
        onChange={(e) => void pick(e.target.value as JackRoomPersonaKey)}
        // 16px on phones so iOS doesn't zoom in on focus
        className="h-8 w-auto text-base font-semibold md:h-7 md:text-sm"
      >
        <option value="stand">Stand (simple tasks)</option>
        <option value="jack">Jack</option>
        <option value="lift">Lift (slower, higher cost)</option>
      </Select>
      {error ? (
        <span role="alert" className="text-xs font-medium text-tone-danger-foreground">
          {error}
        </span>
      ) : null}
    </div>
  )
}

const timeOfDay = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" })

/** Within this many pixels of the bottom, the list follows new text; further up, it leaves the reader where they are */
const FOLLOW_PX = 80

function MessageList({ messages, followSignal }: { messages: JackMessageView[]; followSignal: number }) {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const following = useRef(true)

  // Whenever the conversation grows (text streaming in, a part, a chart loading), keep the end in view,
  // but only for a reader who's at (or near) the bottom
  useEffect(() => {
    const box = scroller.current
    const inner = content.current
    if (!box || !inner) return
    const stick = () => {
      if (following.current) box.scrollTop = box.scrollHeight
    }
    stick()
    const observer = new ResizeObserver(stick)
    observer.observe(inner)
    return () => observer.disconnect()
  }, [])

  // The officer just sent a message: show the end, wherever they were
  useEffect(() => {
    if (!followSignal || !scroller.current) return
    following.current = true
    scroller.current.scrollTop = scroller.current.scrollHeight
  }, [followSignal])

  return (
    <div
      ref={scroller}
      onScroll={(e) => {
        const box = e.currentTarget
        following.current = box.scrollHeight - box.scrollTop - box.clientHeight <= FOLLOW_PX
      }}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4 md:px-5"
    >
      <div ref={content} className={cn(!messages.length && "flex flex-1 flex-col items-center justify-center")}>
        {messages.length ? (
          <ol className="flex flex-col gap-4">
            {messages.map((message) => (
              <MessageRow key={message.id} message={message} />
            ))}
          </ol>
        ) : (
          <div className="flex flex-col items-center gap-1 px-2 text-center">
            <p className="text-sm font-semibold">No messages yet</p>
            <p className="max-w-sm text-[13px] text-muted-foreground">Ask Jack about events, members, LSC entries or payments. Everyone in the room sees the answer as it streams.</p>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * One message. Memoized: the reducer keeps a message's object as it is until that message changes, so
 * while a reply streams only its row re-renders, not every table and chart above it.
 */
const MessageRow = memo(function MessageRow({ message }: { message: JackMessageView }) {
  if (message.author.kind === "system")
    return (
      <li className="flex items-center gap-2.5 text-xs text-admin-subtle">
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
    <li className="flex gap-3">
      {message.author.kind === "assistant" ? (
        <PersonaAvatar persona={message.author.persona} />
      ) : (
        <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-tone-neutral-foreground">
          {message.author.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- officer avatars may be served from various hosts
            <img src={message.author.avatarUrl} alt="" className="size-full rounded-full object-cover" />
          ) : (
            initials(name)
          )}
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[13px]">
          <strong className="font-bold">{name}</strong>{" "}
          <span className="text-xs text-admin-subtle">{message.status === "streaming" ? "answering" : timeOfDay.format(new Date(message.createdAt))}</span>
        </span>
        {isModel ? <ReplyBody message={message} /> : <p className="max-w-3xl whitespace-pre-wrap break-words leading-relaxed">{message.content}</p>}
        {message.status === "error" ? (
          <Notice tone="warning" className="max-w-xl">
            This answer stopped early. Ask again to retry.
          </Notice>
        ) : null}
      </div>
    </li>
  )
})

const streamingCursor = <span aria-hidden className="ml-0.5 inline-block h-[15px] w-[7px] translate-y-0.5 bg-primary" />

/** A model reply: its text, with each tool call drawn where it happened */
function ReplyBody({ message }: { message: JackMessageView }) {
  const pieces = replyPieces(message.content, message.tools)
  const streaming = message.status === "streaming"
  const endsInText = pieces.at(-1)?.kind === "text"
  return (
    <div className="flex max-w-3xl flex-col gap-2">
      {pieces.map((piece, i) =>
        piece.kind === "part" ? (
          <JackToolPartView key={piece.key} part={piece.part} />
        ) : (
          <p key={piece.key} className="whitespace-pre-wrap break-words leading-relaxed text-foreground">
            {piece.text}
            {streaming && i === pieces.length - 1 ? streamingCursor : null}
          </p>
        )
      )}
      {streaming && !endsInText ? <p className="leading-relaxed">{streamingCursor}</p> : null}
    </div>
  )
}

/**
 * For screen readers: "Jack is answering" when a reply starts streaming and "Jack answered" when it
 * ends, never the streamed text itself. Only says something about replies seen streaming here, so
 * opening a room doesn't announce its last answer.
 */
function AnswerStatus({ messages }: { messages: JackMessageView[] }) {
  const last = messages.findLast((m) => m.author.kind === "assistant")
  const name = last?.author.kind === "assistant" ? JACK_PERSONA_NAME[last.author.persona] : ""
  const [seen, setSeen] = useState<{ id: string; status: JackMessageView["status"] } | null>(null)
  const [text, setText] = useState("")
  // Adjusting state while rendering when the last reply changes (React's pattern for reacting to props)
  if (last && (seen?.id !== last.id || seen.status !== last.status)) {
    setSeen({ id: last.id, status: last.status })
    if (last.status === "streaming") setText(`${name} is answering`)
    else if (seen?.id === last.id && seen.status === "streaming") setText(last.status === "error" ? `${name} stopped before finishing` : `${name} answered`)
  }
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {text}
    </p>
  )
}

/** Who stopped: the persona of the reply stuck streaming, or for unanswered messages the room's */
function stalledName(stall: "unanswered" | "stuck", messages: JackMessageView[], persona: JackRoomPersonaKey): string {
  const stuck = stall === "stuck" ? messages.findLast((m) => m.status === "streaming") : undefined
  return JACK_PERSONA_NAME[stuck?.author.kind === "assistant" ? stuck.author.persona : persona]
}

/** Offers to ask Jack to continue when officer messages sit unanswered, or a reply stopped partway */
function ContinueBar({ stall, name, onContinue }: { stall: "unanswered" | "stuck"; name: string; onContinue: RoomViewProps["onContinue"] }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function ask() {
    setPending(true)
    setError(null)
    const problem = await onContinue()
    setPending(false)
    if (problem) setError(problem)
  }

  return (
    <div className="px-4 pb-1 md:px-5">
      <Notice
        tone="warning"
        action={
          <Button size="sm" variant="primary" pending={pending} onClick={() => void ask()}>
            Ask him to continue
          </Button>
        }
      >
        {stall === "stuck" ? `${name} stopped partway through an answer.` : `${name} stopped before answering.`}
        {error ? (
          <span role="alert" className="mt-0.5 block text-xs font-medium text-tone-danger-foreground">
            {error}
          </span>
        ) : null}
      </Notice>
    </div>
  )
}

function Composer({ persona, onSend }: { persona: JackRoomPersonaKey; onSend: RoomViewProps["onSend"] }) {
  const [content, setContent] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  async function send() {
    if (sending || !content.trim()) return
    // Cleared right away, so whatever's typed while it sends is kept; put back if the send fails
    const sent = content
    setContent("")
    setSending(true)
    setError(null)
    const problem = await onSend(sent)
    setSending(false)
    if (problem) {
      setError(problem)
      setContent((typed) => (typed.trim() ? `${sent}\n${typed}` : sent))
    }
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
        // 16px on phones so iOS doesn't zoom in on focus
        className="min-h-14 text-base md:text-sm"
      />
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        {error ? (
          <p role="alert" className="text-xs font-medium text-tone-danger-foreground">
            {error}
          </p>
        ) : (
          <span className="text-xs text-admin-subtle">
            {persona !== "jack" ? `${JACK_PERSONA_NAME[persona]} answers in this room until someone switches it back to Jack.` : "Enter sends, Shift+Enter adds a line."}
          </span>
        )}
        <Button type="submit" variant="primary" pending={sending} disabled={!content.trim()}>
          Send
        </Button>
      </div>
    </form>
  )
}
