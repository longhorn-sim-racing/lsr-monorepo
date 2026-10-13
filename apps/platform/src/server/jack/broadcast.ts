import { JACK_EVENT, jackRoomTopic, type JackRoomEvent } from "@/lib/jack/types"

/** Sends one event to everyone watching a room. Never throws: the database is the record, and viewers catch up from it */
export type RoomBroadcaster = (roomId: string, event: JackRoomEvent) => Promise<void>

const TIMEOUT_MS = 5_000

/**
 * Largest event sent as is. Realtime drops a broadcast over its per-message limit (about 256 KB on the
 * Free plan), and a done event carries every tool display in the reply, so a big one goes out trimmed.
 */
export const MAX_BROADCAST_BYTES = 200_000

/**
 * The event as it can go out: a done event over MAX_BROADCAST_BYTES loses its tool displays (and, if
 * that's still too much, its text), flagged `trimmed`, and viewers load the full reply from the
 * database instead. Other events go as they are; they're small (a delta is ~150 ms of text, a tool
 * event one part).
 */
export function fitForBroadcast(event: JackRoomEvent): JackRoomEvent {
  if (event.type !== JACK_EVENT.done || byteLength(event) <= MAX_BROADCAST_BYTES) return event
  const message = { ...event.message, tools: event.message.tools.map((part) => ({ ...part, displays: [] })) }
  const withoutDisplays = { ...event, message, trimmed: true as const }
  if (byteLength(withoutDisplays) <= MAX_BROADCAST_BYTES) return withoutDisplays
  return { ...withoutDisplays, message: { ...message, content: "", tools: [] } }
}

function byteLength(event: JackRoomEvent) {
  return Buffer.byteLength(JSON.stringify(event), "utf8")
}

/**
 * Broadcasts on the room's private channel through Realtime's REST endpoint. This is the request
 * `channel.httpSend()` makes in @supabase/realtime-js 2.98 (POST {url}/realtime/v1/api/broadcast with
 * `{ messages: [{ topic, event, payload, private: true }] }`, 202 on success), sent with the service
 * role key so it passes the channel's RLS; officers' browsers can only listen and track presence.
 */
export const broadcastRoomEvent: RoomBroadcaster = async (roomId, event) => {
  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!baseUrl || !serviceKey) {
    console.error("[jack] Can't broadcast: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set")
    return
  }

  const payload = fitForBroadcast(event)
  if (payload !== event) console.warn(`[jack] The done event for ${event.type === JACK_EVENT.done ? event.message.id : "?"} in room ${roomId} was too big for Realtime; sent trimmed`)
  const body = JSON.stringify({
    messages: [{ topic: jackRoomTopic(roomId), event: event.type, payload, private: true }],
  })

  // One retry: a dropped delta is recovered from the next snapshot, but a dropped "created" isn't
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/realtime/v1/api/broadcast`, {
        method: "POST",
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (response.status === 202) return
      const detail = await response.text().catch(() => "")
      console.error(`[jack] Broadcast ${event.type} to room ${roomId} failed (${response.status}): ${detail.slice(0, 200)}`)
      if (response.status < 500 && response.status !== 429) return
    } catch (error) {
      console.error(`[jack] Broadcast ${event.type} to room ${roomId} failed:`, error)
    }
  }
}
