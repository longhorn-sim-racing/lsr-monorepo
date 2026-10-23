import { Prisma } from "@prisma/client"
import { Resend } from "resend"
import { z } from "zod"
import { isEmailEventType, type EmailEventType } from "@/lib/email-delivery"
import { prisma } from "@/server/db"
import { recordConnectorSync } from "../state"

/**
 * Resend's delivery webhook (design §12.4): Svix-signed events, one per recipient, delivered at least
 * once and in any order. Verified over the raw body with resend.webhooks.verify() (Svix: HMAC-SHA256
 * over "id.timestamp.body", a constant-time compare, a 5-minute window), then stored once per svix-id
 * in EmailEvent. Only what the console and Jack use is kept: never a click's IP address or browser.
 */

export type SvixHeaders = { id: string; timestamp: string; signature: string }

/** The svix-* headers, or null when one is missing */
export function svixHeaders(headers: Headers): SvixHeaders | null {
  const id = headers.get("svix-id")
  const timestamp = headers.get("svix-timestamp")
  const signature = headers.get("svix-signature")
  return id && timestamp && signature ? { id, timestamp, signature } : null
}

/** Why the signing secret can't be used, or null: it's "whsec_" and base64 */
export function webhookSecretProblem(secret: string | undefined): string | null {
  if (!secret?.trim()) return "RESEND_WEBHOOK_SECRET isn't set"
  if (!secret.startsWith("whsec_")) return "RESEND_WEBHOOK_SECRET should start with whsec_ (the webhook's signing secret in Resend)"
  const key = Buffer.from(secret.slice(6), "base64")
  if (key.length < 16 || key.toString("base64").replace(/=+$/, "") !== secret.slice(6).replace(/=+$/, "")) return "RESEND_WEBHOOK_SECRET isn't a whole signing secret (the part after whsec_ is base64)"
  return null
}

/** Checks the signature and timestamp and returns the parsed payload; throws when either is wrong */
export function verifyResendWebhook(rawBody: string, headers: SvixHeaders, secret: string): unknown {
  // verify() never uses an API key, but the SDK's constructor insists on one; this one is never sent anywhere
  const resend = new Resend(process.env.RESEND_API_KEY || "re_webhook_verify_only")
  return resend.webhooks.verify({ payload: rawBody, headers, webhookSecret: secret })
}

const text = z.string().max(5_000).optional()

const payloadSchema = z.object({
  type: z.string().max(100),
  created_at: text,
  data: z.object({
    email_id: z.string().min(1).max(200),
    created_at: text,
    to: z.union([z.array(z.string().max(320)), z.string().max(320)]).optional(),
    bounce: z.object({ type: text, subType: text, message: text }).optional(),
    failed: z.object({ reason: text }).optional(),
    suppressed: z.object({ type: text, message: text }).optional(),
    click: z.object({ link: text }).optional(),
  }),
})

export type EmailEventRow = {
  svixId: string
  resendId: string
  recipient: string
  type: EmailEventType
  occurredAt: Date
  detail: Record<string, string> | null
}

const clip = (value: string | undefined, max: number) => (value?.trim() ? value.trim().slice(0, max) : undefined)

/** A clicked link without its query string or fragment, which can carry tokens */
function bareLink(link: string | undefined): string | undefined {
  if (!link) return undefined
  try {
    const url = new URL(link)
    return `${url.origin}${url.pathname}`.slice(0, 500)
  } catch {
    return undefined
  }
}

function eventTime(...values: (string | undefined)[]): Date {
  for (const value of values) {
    // Webhooks send ISO times; Resend's API sends "2026-04-03 22:13:42.674981+00", which Date reads once it has a "T"
    const date = value ? new Date(value.includes("T") ? value : value.replace(" ", "T")) : null
    if (date && !Number.isNaN(date.getTime())) return date
  }
  return new Date()
}

/** The row to store for a verified payload, or null for events we don't keep (contacts, domains, inbound mail) */
export function emailEventRow(payload: unknown, svixId: string): EmailEventRow | null {
  const parsed = payloadSchema.safeParse(payload)
  if (!parsed.success || !isEmailEventType(parsed.data.type)) return null
  const { type, data } = parsed.data
  const to = Array.isArray(data.to) ? data.to[0] : data.to
  const detail: Record<string, string | undefined> =
    type === "email.bounced"
      ? { bounceType: clip(data.bounce?.type, 40), subType: clip(data.bounce?.subType, 40), message: clip(data.bounce?.message, 300) }
      : type === "email.failed"
        ? { reason: clip(data.failed?.reason, 200) }
        : type === "email.suppressed"
          ? { suppressedType: clip(data.suppressed?.type, 60), message: clip(data.suppressed?.message, 300) }
          : type === "email.clicked"
            ? { link: bareLink(data.click?.link) }
            : {}
  const kept = Object.fromEntries(Object.entries(detail).filter((entry): entry is [string, string] => Boolean(entry[1])))
  return {
    svixId,
    resendId: data.email_id,
    recipient: (to ?? "").trim().toLowerCase().slice(0, 320),
    type,
    occurredAt: eventTime(parsed.data.created_at, data.created_at),
    detail: Object.keys(kept).length ? kept : null,
  }
}

/** Stores an event once per svix-id (a retried delivery is a no-op). Returns false for a duplicate */
export async function recordEmailEvent(row: EmailEventRow): Promise<boolean> {
  const { count } = await prisma.emailEvent.createMany({ data: [{ ...row, detail: row.detail ?? Prisma.DbNull }], skipDuplicates: true })
  if (count) await recordConnectorSync("resend")
  return count > 0
}
