import { defineConnector } from "../define"
import { recordConnectorError, recordConnectorSync } from "../state"
import { teamsWebhookClient, webhookHost, webhookUrlProblem, type TeamsWebhookClient } from "./client"

/**
 * The `teams-webhook` connector (design §12.8): posting the weekly digest's counts and links to one
 * Teams channel through a Workflows webhook. Separate from the `teams` connector (reading channel
 * messages through Graph), which waits on UT IT; a Workflows flow doesn't need the Graph app. Off until
 * an admin switches it on after its smoke test, and the digest posts to Teams only when its settings say
 * so too.
 */

export const TEAMS_WEBHOOK_CONNECTOR = "teams-webhook"

/** The card the smoke test posts: a real post, so it shows the flow works end to end */
export const SMOKE_CARD = {
  type: "message",
  attachments: [
    {
      contentType: "application/vnd.microsoft.card.adaptive",
      contentUrl: null,
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.2",
        body: [
          { type: "TextBlock", text: "LSR officer console: connection test", weight: "Bolder", wrap: true },
          { type: "TextBlock", text: "An admin tested posting from the console. The weekly digest posts here once it's switched on.", wrap: true, spacing: "Small" },
        ],
      },
    },
  ],
}

/**
 * Posts through the webhook and records the outcome on the connector, so Connections and the
 * failing-connectors check see a flow that was deleted, had its URL rotated or got blocked. Recording
 * never hides the post's own outcome; the error text never has the URL in it
 */
export async function postRecorded(client: TeamsWebhookClient, message: unknown, signal?: AbortSignal): Promise<{ status: number }> {
  let posted: { status: number }
  try {
    posted = await client.post(message, signal)
  } catch (error) {
    await recordConnectorError(TEAMS_WEBHOOK_CONNECTOR, error).catch(() => undefined)
    throw error
  }
  await recordConnectorSync(TEAMS_WEBHOOK_CONNECTOR).catch(() => undefined)
  return posted
}

export const teamsWebhookConnector = defineConnector<TeamsWebhookClient>({
  id: TEAMS_WEBHOOK_CONNECTOR,
  label: "Teams digest posts",
  requiredEnv: ["TEAMS_WEBHOOK_URL"],
  createClient(env) {
    const problem = webhookUrlProblem(env.TEAMS_WEBHOOK_URL)
    if (problem) throw new Error(problem)
    return teamsWebhookClient(env.TEAMS_WEBHOOK_URL!, env)
  },
  // Works while switched off. It posts one short test card: a Workflows webhook has nothing to read, so
  // a post is the only way to know the flow is there and allowed. Being a real post, it's recorded like
  // the digest's, so a fixed flow stops showing as failing without waiting a week for the next digest
  async smoke({ signal } = {}) {
    const problem = webhookUrlProblem(process.env.TEAMS_WEBHOOK_URL)
    if (problem) return { ok: false, summary: problem }
    const client = teamsWebhookClient(process.env.TEAMS_WEBHOOK_URL!)
    const { status } = await postRecorded(client, SMOKE_CARD, signal)
    return { ok: true, summary: `Posted a test card through ${client.host} (answered ${status})` }
  },
  async details() {
    const host = webhookHost(process.env.TEAMS_WEBHOOK_URL)
    const problem = process.env.TEAMS_WEBHOOK_URL ? webhookUrlProblem(process.env.TEAMS_WEBHOOK_URL) : null
    return [
      ...(host ? [{ label: "Posts through", value: host }] : []),
      ...(problem ? [{ label: "Webhook URL", value: problem }] : []),
      { label: "Posts", value: "The weekly digest only, when its settings on Jack → Recurring questions turn Teams on" },
    ]
  },
})
