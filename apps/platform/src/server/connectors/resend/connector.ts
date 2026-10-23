import { formatDistanceStrict } from "date-fns"
import { defineConnector } from "../define"
import { readConnectorState } from "../state"
import { bouncedRecipients, deliveryCounts, deliveryFor, emailsTo, emailTimeline, subjectsFor } from "./delivery"
import { svixSignature } from "./svix"
import { verifyResendWebhook, webhookSecretProblem } from "./webhook"

/** What client() hands out: the delivery records the webhook stored (Resend itself is never called; the production key can only send) */
export const resendDelivery = { deliveryFor, subjectsFor, bouncedRecipients, deliveryCounts, emailsTo, emailTimeline }
export type ResendDelivery = typeof resendDelivery

/**
 * Resend delivery events (design §12.4). Resend calls us (POST /api/webhooks/resend); no Resend API is
 * read, so no read key exists. Its last sync is the last event stored. Switched off, Jack's
 * email_delivery tool says it isn't connected; the webhook keeps storing events either way.
 */
export const resendConnector = defineConnector<ResendDelivery>({
  id: "resend",
  label: "Resend delivery events",
  requiredEnv: ["RESEND_WEBHOOK_SECRET"],
  createClient: () => resendDelivery,
  // Works while switched off. Signs a test message with the secret and checks it the way the route does, then reports the last event that arrived
  async smoke() {
    const secret = process.env.RESEND_WEBHOOK_SECRET
    const problem = webhookSecretProblem(secret)
    if (problem) return { ok: false, summary: problem }
    const body = JSON.stringify({ type: "smoke.test", created_at: new Date().toISOString(), data: {} })
    const ts = Math.floor(Date.now() / 1000)
    verifyResendWebhook(body, { id: "msg_smoke", timestamp: String(ts), signature: svixSignature(secret!, "msg_smoke", ts, body) }, secret!)
    const last = (await readConnectorState("resend"))?.lastSyncAt
    return {
      ok: true,
      summary: last
        ? `The signing secret works; the last delivery event arrived ${formatDistanceStrict(last, new Date(), { addSuffix: true })}`
        : "The signing secret works. No delivery event has arrived yet: send any email, then run this again",
    }
  },
  async details() {
    const last = (await readConnectorState("resend"))?.lastSyncAt
    return [{ label: "Last event", value: last ? formatDistanceStrict(last, new Date(), { addSuffix: true }) : "None yet" }]
  },
})
