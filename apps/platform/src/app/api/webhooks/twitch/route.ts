import { runAfterResponse } from "@/server/after-response"
import { handleEventSub } from "@/server/connectors/twitch/webhook"

/**
 * Twitch EventSub (stream.online and stream.offline, design §12.2). The subscriptions point at
 * https://www.longhornsimracing.org/api/webhooks/twitch exactly (Twitch follows no redirects); they're
 * made by scripts/twitch-eventsub.ts. The raw body is read before anything parses it, because the
 * signature covers its exact bytes. Answers carry no data: a status, or the challenge string.
 */

export const dynamic = "force-dynamic"

/** EventSub messages are a few KB at most */
const MAX_BODY_CHARS = 65_536

export async function POST(request: Request) {
  const rawBody = await request.text()
  if (rawBody.length > MAX_BODY_CHARS) return new Response(null, { status: 413 })
  try {
    const outcome = await handleEventSub(request.headers, rawBody)
    if (outcome.after) void runAfterResponse(outcome.after, "[twitch] Reading a new stream's title failed:")
    if (outcome.text !== undefined) return new Response(outcome.text, { status: outcome.status, headers: { "content-type": "text/plain" } })
    return new Response(null, { status: outcome.status })
  } catch (error) {
    console.error("[twitch] Handling an EventSub delivery failed:", error)
    return new Response(null, { status: 500 })
  }
}
