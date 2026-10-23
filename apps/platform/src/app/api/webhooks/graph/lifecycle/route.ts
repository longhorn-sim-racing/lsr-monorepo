import { handleGraphWebhook } from "@/server/connectors/teams/webhook"

/**
 * Microsoft Graph lifecycle events for the Teams subscriptions (design §12.8): reauthorizationRequired
 * (renew), subscriptionRemoved (make a new one and catch up), missed (catch up). Validated and checked
 * the same way as the notifications route. See src/server/connectors/teams/webhook.ts.
 */

export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function POST(request: Request) {
  return handleGraphWebhook(request, "lifecycle")
}
