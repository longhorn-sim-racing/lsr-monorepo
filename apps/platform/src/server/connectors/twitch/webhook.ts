import { prisma } from "@/server/db"
import { connectorEnabled, recordConnectorSync } from "../state"
import type { ConnectorEnv } from "../types"
import { TWITCH_CONNECTOR_ID, twitchConnector } from "./connector"
import { parseEventSubBody, verifyEventSub } from "./eventsub"
import { closeStreams, recordStreamOnline, updateStreamDetails } from "./streams"
import { clearEventSubRevoked, recordEventSubRevoked } from "./tokens"

/**
 * What /api/webhooks/twitch does with one EventSub delivery (#188, design §12.2), apart from reading
 * the raw body. In order: the signature over the raw body and the 10-minute window (403 otherwise, and
 * always without TWITCH_EVENTSUB_SECRET); the challenge answered with its raw string as text/plain;
 * each message id handled once (a resend gets 204 and nothing else); quick database work only, with the
 * Helix lookup (the stream's title) after the response, since Twitch wants an answer within seconds.
 * Notifications are ignored while the connector is switched off; challenges and revocations aren't.
 *
 * A revocation is kept in SystemSetting "twitch" (`eventsubRevoked`), not as the connector's last
 * error (the next sync would hide it): Streams, Connections and the twitch.attention check show it
 * until a challenge for that type (the setup script subscribing again) or a notification arrives.
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

/** Twitch is delivering to a subscription of `type` again: forget that it was revoked. Never fails the delivery */
async function subscriptionWorks(type: string): Promise<void> {
  try {
    if (await clearEventSubRevoked(type)) console.info(`[twitch] EventSub ${type} is delivering again`)
  } catch (error) {
    console.warn(`[twitch] Couldn't clear the revoked mark for ${type}:`, error instanceof Error ? error.message : error)
  }
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
    // The setup script is subscribing (again)
    await subscriptionWorks(body.subscription.type)
    return { status: 200, text: body.challenge }
  }

  if (body.kind === "revocation") {
    if (await claimEventSubMessage(check.id, "revocation")) {
      const { type, status } = body.subscription
      try {
        await recordEventSubRevoked({ type, status: String(status).slice(0, 80), at: check.at.toISOString() })
      } catch (error) {
        await releaseEventSubMessage(check.id)
        throw error
      }
      console.warn(`[twitch] EventSub ${type} subscription revoked: ${status}`)
    }
    return { status: 204 }
  }

  if (body.kind === "other") return { status: 204 }
  if (!forUs(body.event.broadcaster_user_id)) return { status: 204 }
  await subscriptionWorks(body.subscription.type)
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
    // stream.offline: only the stream it names (a late one for a stream that's closed already must not
    // close the one that replaced it); without an id, every stream that was open when it was sent
    await closeStreams(body.event.id ? { endedAt: check.at, id: body.event.id } : { endedAt: check.at, startedBefore: check.at })
    await recordConnectorSync(TWITCH_CONNECTOR_ID)
    return { status: 204 }
  } catch (error) {
    await releaseEventSubMessage(check.id)
    throw error
  }
}
