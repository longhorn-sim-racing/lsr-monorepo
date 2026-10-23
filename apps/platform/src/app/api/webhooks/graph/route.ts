import { handleGraphWebhook } from "@/server/connectors/teams/webhook"

/**
 * Microsoft Graph change notifications for the Teams channels Jack reads (design §12.8). Graph posts
 * here to validate the endpoint (`?validationToken=`, echoed as text) and with each batch of changes
 * (checked by clientState, answered 202 at once, processed after the response). See
 * src/server/connectors/teams/webhook.ts.
 */

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  return handleGraphWebhook(request, "notifications")
}
