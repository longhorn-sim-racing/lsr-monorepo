import { prisma } from "@/server/db"
import { connectorEnabled, recordConnectorError, recordConnectorSync } from "../state"
import type { ConnectorEnv } from "../types"
import { TWITCH_CONNECTOR_ID, twitchConnector } from "./connector"
import { parseEventSubBody, verifyEventSub } from "./eventsub"
import { closeStreams, recordStreamOnline, updateStreamDetails } from "./streams"

/**
 * What /api/webhooks/twitch does with one EventSub delivery (#188, design §12.2), apart from reading
 * the raw body. In order: the signature over the raw body and the 10-minute window (403 otherwise, and
 * always without TWITCH_EVENTSUB_SECRET); the challenge answered with its raw string as text/plain;
 * each message id handled once (a resend gets 204 and nothing else); quick database work only, with the
 * Helix lookup (the stream's title) after the response, since Twitch wants an answer within seconds.
 * Notifications are ignored while the connector is switched off; challenges and revocations aren't.
 */

export type EventSubOutcome = {
  status: number
  /** text/plain when set (the challenge) */
  text?: string
  /** Runs after the response (runAfterResponse) */
  after?: () => Promise<void>
}

/** Marks a message id handled. False when it already was: a resend */
export async function claimEventSubMessage(id: string, type: string): Promise<boolean> {
  const { count } = await prisma.twitchEventSubMessage.createMany({ data: [{ id, type }], skipDuplicates: true })
  return count === 1
}

/** Undoes a claim when handling failed, so Twitch's resend is handled */
async function releaseEventSubMessage(id: string): Promise<void> {
  await prisma.twitchEventSubMessage.deleteMany({ where: { id } }).catch(() => undefined)
}

/** Reads the channel's title and category for a stream that just went live (the event doesn't carry them) */
async function fillStreamDetails(streamId: string): Promise<void> {
  const client = await twitchConnector.client()
  const channel = await client?.channel()
  if (channel) await updateStreamDetails(streamId, channel)
}

export async function handleEventSub(headers: Headers, rawBody: string, { env = process.env, nowMs = Date.now() }: { env?: ConnectorEnv; nowMs?: number } = {}): Promise<EventSubOutcome> {
  const check = verifyEventSub(headers, rawBody, { secret: env.TWITCH_EVENTSUB_SECRET, nowMs })
  if (!check.ok) {
    console.warn(`[twitch] Refused an EventSub delivery: ${check.reason}`)
    return { status: 403 }
  }
  const body = parseEventSubBody(check.type, rawBody)
  if (!body) return { status: 400 }
  const broadcasterId = env.TWITCH_BROADCASTER_ID?.trim()
  const forUs = (id: string | undefined) => Boolean(broadcasterId) && id === broadcasterId

  if (body.kind === "challenge") {
    // Signed with our secret, so we made it; still, only ever subscribe the club's own channel
    if (!forUs(body.subscription.condition.broadcaster_user_id)) {
      console.warn(`[twitch] Refused a ${body.subscription.type} subscription for a channel other than TWITCH_BROADCASTER_ID`)
      return { status: 403 }
    }
    return { status: 200, text: body.challenge }
  }

  if (body.kind === "revocation") {
    if (await claimEventSubMessage(check.id, "revocation")) {
      const { type, status } = body.subscription
      await recordConnectorError(TWITCH_CONNECTOR_ID, `Twitch revoked the ${type} webhook subscription (${status}). Run scripts/twitch-eventsub.ts --apply again (docs/jack-2/tracks/sources-b.md).`)
      console.warn(`[twitch] EventSub ${type} subscription revoked: ${status}`)
    }
    return { status: 204 }
  }

  if (body.kind === "other") return { status: 204 }
  if (!forUs(body.event.broadcaster_user_id)) return { status: 204 }
  if (!(await connectorEnabled(TWITCH_CONNECTOR_ID))) {
    console.info(`[twitch] Ignored ${body.subscription.type}: the Twitch connector is switched off`)
    return { status: 204 }
  }
  if (!(await claimEventSubMessage(check.id, "notification"))) return { status: 204 }

  try {
    if (body.kind === "online") {
      // Reruns, premieres and watch parties aren't the club going live
      if (body.event.type !== "live") return { status: 204 }
      const streamId = body.event.id
      await recordStreamOnline({ id: streamId, startedAt: new Date(body.event.started_at) })
      await recordConnectorSync(TWITCH_CONNECTOR_ID)
      return { status: 204, after: () => fillStreamDetails(streamId) }
    }
    // stream.offline: the stream it names, or every stream that was open when it was sent
    const named = body.event.id ? await prisma.twitchStream.findFirst({ where: { id: body.event.id, endedAt: null }, select: { id: true } }) : null
    await closeStreams(named ? { endedAt: check.at, id: named.id } : { endedAt: check.at, startedBefore: check.at })
    await recordConnectorSync(TWITCH_CONNECTOR_ID)
    return { status: 204 }
  } catch (error) {
    await releaseEventSubMessage(check.id)
    throw error
  }
}
