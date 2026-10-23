import { NextResponse } from "next/server"
import { resendConnector } from "@/server/connectors/resend/connector"
import { emailEventRow, recordEmailEvent, svixHeaders, verifyResendWebhook } from "@/server/connectors/resend/webhook"

/**
 * Resend's delivery events (Jack 2.0, design §12.4). The signature is checked over the raw body before
 * anything is parsed; without RESEND_WEBHOOK_SECRET every request is refused (503, so Resend retries
 * once the secret is set). Each event is stored once per svix-id, so retries are no-ops. While the
 * connector is switched off nothing is stored: the event is still answered 200, so Resend counts it as
 * delivered and neither retries it nor disables the endpoint (those events are gone for good; there's
 * no read key to fetch them later). Nothing here logs a body, an address or a secret.
 */

export const dynamic = "force-dynamic"

/** A delivery event is about 1 KB; anything this big isn't one */
const MAX_BODY_CHARS = 256_000

export async function POST(request: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET
  if (!secret) return NextResponse.json({ ok: false }, { status: 503 })

  const rawBody = await request.text()
  if (rawBody.length > MAX_BODY_CHARS) return NextResponse.json({ ok: false }, { status: 413 })
  const headers = svixHeaders(request.headers)
  if (!headers) return NextResponse.json({ ok: false }, { status: 400 })

  let payload: unknown
  try {
    payload = verifyResendWebhook(rawBody, headers, secret)
  } catch (error) {
    console.warn(`[resend webhook] Refused an event: ${error instanceof Error ? error.message : "bad signature"}`)
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  const row = emailEventRow(payload, headers.id)
  if (!row) return NextResponse.json({ ok: true, stored: false })
  try {
    // Switched off on System → Connections: keep nothing (members' addresses included)
    if (!(await resendConnector.enabled())) return NextResponse.json({ ok: true, stored: false })
    const stored = await recordEmailEvent(row)
    return NextResponse.json({ ok: true, stored })
  } catch (error) {
    // Only the error's kind: a database error can quote the row, and the row has an address
    console.error(`[resend webhook] Couldn't store a ${row.type} event: ${error instanceof Error ? error.name : "error"}`)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
