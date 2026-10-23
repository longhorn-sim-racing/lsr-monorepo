import type { FakeService } from "../../fakes/types"

/**
 * A Teams Workflows webhook ("Post to a channel when a webhook request is received"), mounted at
 * /teams-webhook (research/microsoft-graph.md, "How to fake it locally"). It takes a POST to any
 * `/…/workflows/…` path, the way a flow's URL looks, and:
 * - refuses a request with an auth header (400): a flow set to "Anyone" takes none;
 * - checks the body is `type: "message"` with an Adaptive Card as its first attachment (400 otherwise);
 * - needs the flow's `sig` query (401 without, as Logic Apps answers);
 * - answers 202 and keeps the card.
 * Test hooks: `GET /_fake/cards` (what was posted), `POST /_fake/fail { status }` (the next post gets
 * that status; 0 clears it), `POST /_fake/reset`.
 */

export const ADAPTIVE_CARD = "application/vnd.microsoft.card.adaptive"

export const teamsWebhookFake: FakeService = {
  id: "teams-webhook",
  create() {
    const cards: { path: string; card: unknown; at: string }[] = []
    let failNext = 0

    return [
      { method: "GET", path: "/_fake/cards", handle: () => Response.json({ cards }) },
      {
        method: "POST",
        path: "/_fake/fail",
        async handle(request) {
          const body = (await request.json().catch(() => ({}))) as { status?: unknown }
          failNext = typeof body.status === "number" ? body.status : 0
          return Response.json({ failNext })
        },
      },
      {
        method: "POST",
        path: "/_fake/reset",
        handle() {
          cards.length = 0
          failNext = 0
          return Response.json({ ok: true })
        },
      },
      {
        method: "POST",
        path: "/*",
        async handle(request, { path }) {
          if (!/\/workflows\//i.test(path)) return Response.json({ error: { code: "NotFound", message: "No workflow at this path." } }, { status: 404 })
          if (request.headers.get("authorization")) return Response.json({ error: { code: "DirectApiAuthorizationRequired", message: "The flow takes requests from anyone: send no authorization header." } }, { status: 400 })
          if (!new URL(request.url).searchParams.get("sig")) return Response.json({ error: { code: "DirectApiInvalidAuthorizationScheme", message: "The request is missing its signature." } }, { status: 401 })
          if (failNext) {
            const status = failNext
            failNext = 0
            return Response.json({ error: { code: "FakeFailure", message: "The fake was told to fail this post." } }, { status })
          }
          const body = (await request.json().catch(() => null)) as { type?: unknown; attachments?: { contentType?: unknown; content?: { type?: unknown } }[] } | null
          const first = body?.attachments?.[0]
          if (body?.type !== "message" || first?.contentType !== ADAPTIVE_CARD || first.content?.type !== "AdaptiveCard") {
            return Response.json({ error: { code: "InvalidRequestContent", message: "Send a message with an Adaptive Card as its first attachment." } }, { status: 400 })
          }
          cards.push({ path, card: first.content, at: new Date().toISOString() })
          return new Response(null, { status: 202 })
        },
      },
    ]
  },
}
