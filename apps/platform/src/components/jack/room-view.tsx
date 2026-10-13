"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import {
  JACK_PERSONA_NAME,
  JACK_ROOM_PERSONAS,
  type JackMessageView,
  type JackPresence,
  type JackRoomPersonaKey,
} from "@/lib/jack/types"
import type { JackConnection } from "./use-jack-room"

/*
 * Jack's room, drawn plainly on purpose: these components only render what they're given and report
 * what the officer does. The live logic is in use-jack-room.ts, so a restyle only touches this file.
 */

type RoomViewProps = {
  title: string
  persona: JackRoomPersonaKey
  messages: JackMessageView[]
  present: JackPresence[]
  connection: JackConnection
  /** Resolves with an error to show, or null once the message is posted */
  onSend: (content: string) => Promise<string | null>
  /** Resolves with an error to show, or null once switched */
  onSwitchPersona: (persona: JackRoomPersonaKey) => Promise<string | null>
}

export function JackRoomView({ title, persona, messages, present, connection, onSend, onSwitchPersona }: RoomViewProps) {
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div>
        <Link href="/admin/jack" className="text-sm underline">
          All rooms
        </Link>
        <h1 className="text-2xl font-bold">{title}</h1>
        <ConnectionLine connection={connection} />
        <PresenceLine present={present} />
        <PersonaSwitch persona={persona} onSwitch={onSwitchPersona} />
      </div>
      <MessageList messages={messages} />
      <Composer onSend={onSend} />
    </div>
  )
}

function ConnectionLine({ connection }: { connection: JackConnection }) {
  const text = { connecting: "Connecting...", live: "Live", error: "Not connected. Reload the page to see new messages." }[connection]
  return <p className="text-sm">{text}</p>
}

function PresenceLine({ present }: { present: JackPresence[] }) {
  if (!present.length) return null
  return <p className="text-sm">In the room: {present.map((p) => p.displayName).join(", ")}</p>
}

/** What each persona runs on, shown next to the switch */
const PERSONA_NOTE: Record<JackRoomPersonaKey, string> = {
  jack: "Sonnet, the default",
  lift: "Opus, for hard questions, about 2x the cost",
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
    <fieldset className="mt-2 flex flex-wrap items-center gap-3 text-sm" disabled={switching}>
      <legend className="sr-only">Who answers in this room</legend>
      <span>Answering here: {JACK_PERSONA_NAME[persona]}.</span>
      {JACK_ROOM_PERSONAS.map((option) => (
        <label key={option} className="flex items-center gap-1">
          <input type="radio" name="jack-persona" checked={persona === option} onChange={() => void pick(option)} />
          {JACK_PERSONA_NAME[option]} ({PERSONA_NOTE[option]})
        </label>
      ))}
      {error ? <span className="text-red-600">{error}</span> : null}
    </fieldset>
  )
}

function authorName(message: JackMessageView) {
  switch (message.author.kind) {
    case "assistant":
      return JACK_PERSONA_NAME[message.author.persona]
    case "user":
      return message.author.displayName
    case "system":
      return null
  }
}

function MessageList({ messages }: { messages: JackMessageView[] }) {
  const end = useRef<HTMLDivElement>(null)
  const last = messages.at(-1)
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" })
  }, [messages.length, last?.content])

  if (!messages.length) return <p className="text-sm">No messages yet. Ask Jack something.</p>
  return (
    <div>
      <ol className="flex flex-col gap-3">
        {messages.map((message) =>
          message.author.kind === "system" ? (
            <li key={message.id} className="px-3 text-sm italic">
              {message.content}
            </li>
          ) : (
            <li key={message.id} className="rounded border p-3">
              <p className="text-sm font-semibold">
                {authorName(message)}
                {message.status === "streaming" ? " (typing...)" : null}
              </p>
              <p className="whitespace-pre-wrap">{message.content}</p>
              {message.status === "error" ? (
                <p className="text-sm text-red-600">This answer stopped early. Ask again to retry.</p>
              ) : null}
            </li>
          )
        )}
      </ol>
      <div ref={end} />
    </div>
  )
}

function Composer({ onSend }: { onSend: RoomViewProps["onSend"] }) {
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
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
    >
      <label htmlFor="jack-message" className="text-sm">
        Message (Enter sends, Shift+Enter for a new line)
      </label>
      <textarea
        id="jack-message"
        className="rounded border p-2"
        rows={3}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void send()
          }
        }}
      />
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <button type="submit" className="self-start rounded border px-3 py-1" disabled={sending || !content.trim()}>
        {sending ? "Sending..." : "Send"}
      </button>
    </form>
  )
}
