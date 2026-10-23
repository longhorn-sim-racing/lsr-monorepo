import { serviceBaseUrl } from "../base-url"
import type { ConnectorEnv } from "../types"

/**
 * Posting to a Teams channel through a Workflows webhook (design §12.8, research/microsoft-graph.md §3g):
 * a team member makes a flow from the template "Post to a channel when a webhook request is received"
 * and the URL it shows goes in TEAMS_WEBHOOK_URL. The weekly digest is the only thing that posts.
 *
 * - The URL itself is the secret (its `sig` query): it's never logged, never in an error, and only its
 *   host is ever shown. With the flow's auth on "Anyone", no auth header is sent (one makes it a 400).
 * - The body is a message with one Adaptive Card. Workflows answers 202 (research: UNVERIFIED; any 2xx
 *   counts). A redirect is an error, not followed.
 * - At most 25 posts per 5 minutes per connection (the Flow bot's limit); the digest posts once a week.
 */

/** The longest one post may take */
export const TEAMS_WEBHOOK_TIMEOUT_MS = 15_000

/** Where Workflows webhook URLs live: Logic Apps (prod-NN.<region>.logic.azure.com) and Power Platform environments */
const WEBHOOK_HOST = /(^|\.)logic\.azure\.com$|(^|\.)api\.powerplatform\.com$/i

export class TeamsWebhookError extends Error {
  constructor(readonly status: number | null, detail: string) {
    super(`The Teams webhook ${status === null ? "couldn't be reached" : `answered ${status}`}${detail ? ` (${detail})` : ""}`)
    this.name = "TeamsWebhookError"
  }
}

/** Why a webhook URL can't be the one, in a sentence that never repeats it, or null when it looks right */
export function webhookUrlProblem(raw: string | undefined): string | null {
  if (!raw?.trim()) return "TEAMS_WEBHOOK_URL isn't set."
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return "TEAMS_WEBHOOK_URL isn't a URL."
  }
  if (url.protocol !== "https:") return "TEAMS_WEBHOOK_URL must be https."
  if (!WEBHOOK_HOST.test(url.hostname)) return "TEAMS_WEBHOOK_URL isn't a Workflows webhook (its host should end in logic.azure.com or api.powerplatform.com)."
  if (!/\/workflows\//i.test(url.pathname)) return "TEAMS_WEBHOOK_URL isn't a Workflows webhook (its path should have /workflows/ in it)."
  return null
}

/** The webhook's host, safe to show (the path and query carry the secret) */
export function webhookHost(raw: string | undefined): string | null {
  try {
    return raw ? new URL(raw.trim()).hostname : null
  } catch {
    return null
  }
}

export function teamsWebhookClient(rawUrl: string, env: ConnectorEnv = process.env) {
  const url = new URL(rawUrl.trim())
  // With fakes on, the same path and query on the fakes server (the query carries the flow's signature)
  const target = `${serviceBaseUrl("teams-webhook", `${url.origin}${url.pathname}`, env)}${url.search}`

  return {
    host: url.hostname,
    /** Posts one message (a card); throws TeamsWebhookError without the URL on anything but a 2xx */
    async post(message: unknown, signal?: AbortSignal): Promise<{ status: number }> {
      const timeout = AbortSignal.timeout(TEAMS_WEBHOOK_TIMEOUT_MS)
      let response: Response
      try {
        response = await fetch(target, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(message),
          redirect: "manual",
          cache: "no-store",
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        })
      } catch (error) {
        throw new TeamsWebhookError(null, timeout.aborted ? `no answer in ${TEAMS_WEBHOOK_TIMEOUT_MS / 1000} s` : error instanceof Error ? error.name : "network error")
      }
      if (response.status >= 200 && response.status < 300) return { status: response.status }
      // Workflows' error bodies are JSON with a code; keep only the code
      const body = (await response.json().catch(() => null)) as { error?: { code?: unknown } } | null
      const code = typeof body?.error?.code === "string" ? body.error.code.slice(0, 60) : ""
      throw new TeamsWebhookError(response.status, response.status >= 300 && response.status < 400 ? "a redirect; check the URL" : code)
    },
  }
}

export type TeamsWebhookClient = ReturnType<typeof teamsWebhookClient>
