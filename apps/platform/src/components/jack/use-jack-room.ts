"use client"

import { useCallback, useEffect, useReducer, useState } from "react"
import type { RealtimeChannel } from "@supabase/supabase-js"
import { createSupabaseBrowser } from "@/lib/supabase-browser"
import { initRoomState, roomReducer, type RoomSnapshotData } from "@/lib/jack/room-state"
import {
  JACK_EVENT,
  jackRoomTopic,
  type JackMessageView,
  type JackPresence,
  type JackRoomEvent,
  type JackRoomPersonaKey,
  type JackRoomView,
} from "@/lib/jack/types"
import type { ActionResult } from "@/lib/action-result"

export type JackConnection = "connecting" | "live" | "error"

type Options = {
  roomId: string
  me: JackPresence
  /** The room as the server rendered it */
  initial: RoomSnapshotData
  loadSnapshot: (roomId: string) => Promise<ActionResult<RoomSnapshotData>>
  postMessage: (roomId: string, content: string) => Promise<ActionResult<JackMessageView>>
  setPersona: (
    roomId: string,
    persona: JackRoomPersonaKey
  ) => Promise<ActionResult<{ room: JackRoomView; message: JackMessageView | null }>>
}

/** First wait before refetching a snapshot to close a gap; later tries wait longer (the database saves about once a second) */
const RESYNC_DELAY_MS = 600
const MAX_RESYNC_ATTEMPTS = 8

/**
 * Channels still leaving, by topic. supabase-js hands back the existing channel for a topic until the
 * server acknowledges the leave, so joining again right away (React's dev double effects, or going back
 * to a room) has to wait for it.
 */
const leaving = new Map<string, Promise<unknown>>()

/**
 * A room's live state: its messages (snapshot + live events through the pure reducer), who's in it,
 * and the connection. All the logic of the room page lives here; the components only draw it.
 */
export function useJackRoom({ roomId, me, initial, loadSnapshot, postMessage, setPersona }: Options) {
  const [state, dispatch] = useReducer(roomReducer, initial, initRoomState)
  const [present, setPresent] = useState<JackPresence[]>([])
  const [connection, setConnection] = useState<JackConnection>("connecting")

  const resync = useCallback(async () => {
    const result = await loadSnapshot(roomId).catch(() => null)
    if (result?.ok) dispatch({ type: "snapshot", room: result.data.room, messages: result.data.messages })
  }, [roomId, loadSnapshot])

  useEffect(() => {
    const supabase = createSupabaseBrowser()
    const topic = jackRoomTopic(roomId)
    let channel: RealtimeChannel | null = null
    let closed = false
    const onEvent = ({ payload }: { payload: JackRoomEvent }) => dispatch(payload)

    void (async () => {
      await leaving.get(topic)
      // A private channel joins with the member's JWT, so hand it to Realtime before subscribing
      await supabase.realtime.setAuth()
      if (closed) return

      const ch = supabase.channel(topic, { config: { private: true, presence: { key: me.userId } } })
      channel = ch
      ch.on("broadcast", { event: JACK_EVENT.created }, onEvent)
        .on("broadcast", { event: JACK_EVENT.delta }, onEvent)
        .on("broadcast", { event: JACK_EVENT.done }, onEvent)
        .on("broadcast", { event: JACK_EVENT.room }, onEvent)
        .on("presence", { event: "sync" }, () => setPresent(presentOfficers(ch.presenceState<JackPresence>())))
        .subscribe((status) => {
          if (closed) return
          if (status === "SUBSCRIBED") {
            setConnection("live")
            void ch.track({ userId: me.userId, displayName: me.displayName })
            // Catch up on whatever went out before this join (or during a reconnect)
            void resync()
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            setConnection("error")
          }
        })
    })()

    return () => {
      closed = true
      if (!channel) return
      const left = supabase.removeChannel(channel).finally(() => {
        if (leaving.get(topic) === left) leaving.delete(topic)
      })
      leaving.set(topic, left)
    }
  }, [roomId, me.userId, me.displayName, resync])

  // A streaming reply has a gap: fetch a fresh snapshot, waiting longer each time while the database catches up
  useEffect(() => {
    if (!state.needsResync || state.resyncAttempts >= MAX_RESYNC_ATTEMPTS) return
    const timer = setTimeout(() => void resync(), RESYNC_DELAY_MS * (state.resyncAttempts + 1))
    return () => clearTimeout(timer)
  }, [state.needsResync, state.resyncAttempts, resync])

  const send = useCallback(
    async (content: string) => {
      const result = await postMessage(roomId, content)
      if (result.ok) dispatch({ type: JACK_EVENT.created, message: result.data })
      return result
    },
    [roomId, postMessage]
  )

  const switchPersona = useCallback(
    async (persona: JackRoomPersonaKey) => {
      const result = await setPersona(roomId, persona)
      if (result.ok) {
        dispatch({ type: JACK_EVENT.room, room: result.data.room })
        if (result.data.message) dispatch({ type: JACK_EVENT.created, message: result.data.message })
      }
      return result
    },
    [roomId, setPersona]
  )

  return { room: state.room, messages: state.messages, present, connection, send, switchPersona }
}

/** One entry per officer, however many tabs they have open */
function presentOfficers(state: Record<string, JackPresence[]>): JackPresence[] {
  return Object.values(state)
    .map((metas) => metas[0])
    .filter((meta): meta is JackPresence => Boolean(meta?.userId))
    .map(({ userId, displayName }) => ({ userId, displayName }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
}
