"use client"

import { useCallback, useEffect, useReducer, useRef, useState } from "react"
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js"
import { createSupabaseBrowser } from "@/lib/supabase-browser"
import { initRoomState, roomReducer, stallCandidate, stallQuietMs, type RoomSnapshotData } from "@/lib/jack/room-state"
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

/**
 * Why the room offers to ask Jack to continue: officer messages no reply picked up ("unanswered": the
 * run ran out of time, or never started), or a reply that stopped streaming partway ("stuck": the run
 * writing it died). Null when nothing looks stuck
 */
export type JackStall = "unanswered" | "stuck" | null

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
  rename: (roomId: string, title: string) => Promise<ActionResult<{ room: JackRoomView; message: JackMessageView | null }>>
  resume: (roomId: string) => Promise<ActionResult>
}

/** First wait before refetching a snapshot to close a gap; later tries wait longer (the database saves about once a second) */
const RESYNC_DELAY_MS = 600
const MAX_RESYNC_ATTEMPTS = 8
/**
 * While a reply streams, a snapshot after this long with no room events, in case its deltas or done
 * event went missing; each one after that waits twice as long, up to QUIET_RESYNC_MAX_MS
 */
const QUIET_RESYNC_MS = 30_000
const QUIET_RESYNC_MAX_MS = 5 * 60_000
/** A snapshot this long after the last done event, for anything missed around it (another officer's message, a part) */
const AFTER_DONE_RESYNC_MS = 1_500
/** Joining again after the server closed the channel: the first wait, doubling up to the last */
const REJOIN_FIRST_MS = 1_000
const REJOIN_MAX_MS = 30_000
/**
 * A note asking Jack to keep going on a deck (#177) gets a run started this long after the room goes
 * quiet; a run still letting go of the room answers "busy", so try again a few times, further apart
 */
const AUTO_CONTINUE_MS = 1_500
const AUTO_CONTINUE_RETRY_MS = 8_000
const AUTO_CONTINUE_TRIES = 4

/**
 * Channels still leaving, by topic. supabase-js hands back the existing channel for a topic until the
 * server acknowledges the leave, so joining again right away (React's dev double effects, or going back
 * to a room) has to wait for it.
 */
const leaving = new Map<string, Promise<unknown>>()

/**
 * Removing the last channel makes supabase-js disconnect the socket, and a join started while that
 * disconnect is still going never connects (connect() does nothing while disconnecting). Waits for it
 * to finish, which takes at most ~100 ms (supabase-js gives up on the old socket after that).
 */
async function socketSettled(supabase: SupabaseClient) {
  for (let i = 0; i < 40 && supabase.realtime.isDisconnecting(); i++) await new Promise((done) => setTimeout(done, 50))
}

/**
 * A room's live state: its messages (snapshot + live events through the pure reducer), who's in it,
 * the connection, and whether it looks stuck. All the logic of the room page lives here; the
 * components only draw it.
 */
export function useJackRoom({ roomId, me, initial, loadSnapshot, postMessage, setPersona, rename, resume }: Options) {
  const [state, dispatch] = useReducer(roomReducer, initial, initRoomState)
  const [present, setPresent] = useState<JackPresence[]>([])
  const [connection, setConnection] = useState<JackConnection>("connecting")
  /** Bumped to join the channel again after the server closed it */
  const [joinAttempt, setJoinAttempt] = useState(0)
  const rejoins = useRef(0)
  /** When this viewer last heard from the room: a live event, or their own post or switch */
  const [lastEventAt, setLastEventAt] = useState(() => Date.now())
  /** The last snapshot taken because a streaming room went quiet, and how many in a row */
  const [quietResync, setQuietResync] = useState({ at: 0, count: 0 })
  /** When a fresh snapshot last confirmed the room looked stuck */
  const [stallCheckedAt, setStallCheckedAt] = useState(0)
  /** Tries to start a run for each waiting continue note, by note id, and a counter to try again */
  const autoContinued = useRef<Record<string, number>>({})
  const [autoRetry, setAutoRetry] = useState(0)
  const afterDone = useRef<ReturnType<typeof setTimeout> | null>(null)

  const resync = useCallback(async () => {
    const result = await loadSnapshot(roomId).catch(() => null)
    if (result?.ok) dispatch({ type: "snapshot", room: result.data.room, messages: result.data.messages })
    else dispatch({ type: "resync_failed" })
  }, [roomId, loadSnapshot])

  useEffect(() => {
    const supabase = createSupabaseBrowser()
    const topic = jackRoomTopic(roomId)
    let channel: RealtimeChannel | null = null
    let closed = false
    let rejoinTimer: ReturnType<typeof setTimeout> | null = null
    const onEvent = ({ payload }: { payload: JackRoomEvent }) => {
      dispatch(payload)
      setLastEventAt(Date.now())
      if (payload.type === JACK_EVENT.done) {
        if (afterDone.current) clearTimeout(afterDone.current)
        afterDone.current = setTimeout(() => void resync(), AFTER_DONE_RESYNC_MS)
      }
    }

    void (async () => {
      await leaving.get(topic)
      await socketSettled(supabase)
      // A private channel joins with the member's JWT, so hand it to Realtime before subscribing
      await supabase.realtime.setAuth()
      if (closed) return

      const ch = supabase.channel(topic, { config: { private: true, presence: { key: me.userId } } })
      channel = ch
      ch.on("broadcast", { event: JACK_EVENT.created }, onEvent)
        .on("broadcast", { event: JACK_EVENT.delta }, onEvent)
        .on("broadcast", { event: JACK_EVENT.done }, onEvent)
        .on("broadcast", { event: JACK_EVENT.tool }, onEvent)
        .on("broadcast", { event: JACK_EVENT.room }, onEvent)
        .on("presence", { event: "sync" }, () => setPresent(presentOfficers(ch.presenceState<JackPresence>())))
        .subscribe((status) => {
          if (closed) return
          if (status === "SUBSCRIBED") {
            rejoins.current = 0
            setConnection("live")
            void ch.track({ userId: me.userId, displayName: me.displayName, avatarUrl: me.avatarUrl })
            // Catch up on whatever went out before this join (or during a reconnect)
            void resync()
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            setConnection("error") // supabase-js tries these again itself
          } else if (status === "CLOSED") {
            // The server closed the channel, and supabase-js won't rejoin it: join again, backing off
            setConnection("error")
            const wait = Math.min(REJOIN_MAX_MS, REJOIN_FIRST_MS * 2 ** rejoins.current++)
            rejoinTimer = setTimeout(() => setJoinAttempt((n) => n + 1), wait)
          }
        })
    })()

    return () => {
      closed = true
      if (rejoinTimer) clearTimeout(rejoinTimer)
      if (afterDone.current) clearTimeout(afterDone.current)
      if (!channel) return
      const left = supabase.removeChannel(channel).finally(() => {
        if (leaving.get(topic) === left) leaving.delete(topic)
      })
      leaving.set(topic, left)
    }
  }, [roomId, me.userId, me.displayName, me.avatarUrl, resync, joinAttempt])

  // A streaming reply has a gap, or a done event came trimmed: fetch a fresh snapshot, waiting longer
  // each time while the database catches up (a failed fetch counts as a try too)
  useEffect(() => {
    if (!state.needsResync || state.resyncAttempts >= MAX_RESYNC_ATTEMPTS) return
    const timer = setTimeout(() => void resync(), RESYNC_DELAY_MS * (state.resyncAttempts + 1))
    return () => clearTimeout(timer)
  }, [state.needsResync, state.resyncAttempts, resync])

  // Officer messages no reply has picked up, or a reply stuck streaming, after the room's been quiet a
  // while: check the database once more, then offer to ask Jack to continue
  const candidate = stallCandidate(state.messages)

  // A reply is streaming but the room has gone quiet: a missed done (or created) event would leave it
  // "answering" forever, so look at the database after QUIET_RESYNC_MS, then less and less often (a
  // room event starts it over). Not while the room offers "continue": a reply that's really stuck stays
  // that way until someone asks, and every open tab would keep fetching the room for nothing
  const streaming = state.messages.some((m) => m.status === "streaming")
  const stuckOffered = candidate === "stuck" && stallCheckedAt > lastEventAt
  useEffect(() => {
    if (!streaming || stuckOffered) return
    const inARow = quietResync.at > lastEventAt ? quietResync.count : 0
    const since = Math.max(lastEventAt, quietResync.at)
    const wait = Math.min(QUIET_RESYNC_MAX_MS, QUIET_RESYNC_MS * 2 ** inARow)
    const timer = setTimeout(() => {
      setQuietResync({ at: Date.now(), count: inARow + 1 })
      void resync()
    }, Math.max(0, since + wait - Date.now()))
    return () => clearTimeout(timer)
  }, [streaming, stuckOffered, lastEventAt, quietResync, resync])

  useEffect(() => {
    if (!candidate) return
    const timer = setTimeout(
      async () => {
        await resync()
        setStallCheckedAt(Date.now())
      },
      Math.max(0, lastEventAt + stallQuietMs(candidate) - Date.now())
    )
    return () => clearTimeout(timer)
  }, [candidate, lastEventAt, resync])
  const stall: JackStall = candidate && stallCheckedAt > lastEventAt ? candidate : null

  // A deck job that hit a reply's limits left a note asking Jack to keep going: start the next run as
  // soon as nothing is streaming, instead of waiting for the stall offer. Every open tab tries; the
  // room lock lets one run through and the others hear "busy"
  const waitingNote = state.messages.find((m) => m.continues && !m.answered)?.id ?? null
  useEffect(() => {
    if (!waitingNote || streaming) return
    const tries = autoContinued.current[waitingNote] ?? 0
    if (tries >= AUTO_CONTINUE_TRIES) return
    const timer = setTimeout(
      async () => {
        autoContinued.current[waitingNote] = tries + 1
        const result = await resume(roomId).catch(() => null)
        if (result?.ok) setLastEventAt(Date.now())
        else setAutoRetry((n) => n + 1)
      },
      tries === 0 ? AUTO_CONTINUE_MS : AUTO_CONTINUE_RETRY_MS
    )
    return () => clearTimeout(timer)
  }, [waitingNote, streaming, roomId, resume, autoRetry])

  const send = useCallback(
    async (content: string) => {
      const result = await postMessage(roomId, content)
      if (result.ok) {
        dispatch({ type: JACK_EVENT.created, message: result.data })
        setLastEventAt(Date.now())
      }
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

  const renameRoom = useCallback(
    async (title: string) => {
      const result = await rename(roomId, title)
      if (result.ok) {
        dispatch({ type: JACK_EVENT.room, room: result.data.room })
        if (result.data.message) dispatch({ type: JACK_EVENT.created, message: result.data.message })
      }
      return result
    },
    [roomId, rename]
  )

  /** Asks the server to start a run; the room then waits quietly again before offering it a second time */
  const continueRoom = useCallback(async () => {
    const result = await resume(roomId)
    if (result.ok) setLastEventAt(Date.now())
    return result
  }, [roomId, resume])

  return { room: state.room, messages: state.messages, present, connection, stall, send, switchPersona, renameRoom, continueRoom }
}

/** One entry per officer, however many tabs they have open. A tab from before #183 tracks no picture */
function presentOfficers(state: Record<string, JackPresence[]>): JackPresence[] {
  return Object.values(state)
    .map((metas) => metas[0])
    .filter((meta): meta is JackPresence => Boolean(meta?.userId))
    .map(({ userId, displayName, avatarUrl }) => ({ userId, displayName, avatarUrl: avatarUrl ?? null }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
}
