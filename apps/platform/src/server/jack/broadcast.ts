import { jackRoomTopic, type JackRoomEvent } from "@/lib/jack/types"

/** Sends one event to everyone watching a room. Never throws: the database is the record, and viewers catch up from it */
export type RoomBroadcaster = (roomId: string, event: JackRoomEvent) => Promise<void>

const TIMEOUT_MS = 5_000

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

  const body = JSON.stringify({
    messages: [{ topic: jackRoomTopic(roomId), event: event.type, payload: event, private: true }],
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
