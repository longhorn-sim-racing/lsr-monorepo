/**
 * What happened to an email after Resend took it, worked out from every delivery event we got for it
 * (Jack 2.0 design §12.4). Events come by webhook, at least once and in any order (an "opened" can land
 * before its "delivered"), so the status is computed when it's read, from all of them, never from the
 * last one to arrive. Pure, so client components and tests use it too.
 */

/** Resend's email event types we keep (EmailEvent.type) */
export const EMAIL_EVENT_TYPES = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.opened",
  "email.clicked",
  "email.failed",
  "email.suppressed",
] as const

export type EmailEventType = (typeof EMAIL_EVENT_TYPES)[number]

export function isEmailEventType(type: string): type is EmailEventType {
  return (EMAIL_EVENT_TYPES as readonly string[]).includes(type)
}

export type DeliveryStatus = "complained" | "bounced" | "failed" | "suppressed" | "clicked" | "opened" | "delivered" | "delayed" | "sent"

/**
 * Strongest first: a final failure beats everything (a complaint, then a bounce, a failure, a
 * suppression); then engagement, which means it was delivered (a click, then an open); then delivered,
 * delayed (Resend still retrying) and sent (accepted, no report yet)
 */
const RANK: [EmailEventType, DeliveryStatus][] = [
  ["email.complained", "complained"],
  ["email.bounced", "bounced"],
  ["email.failed", "failed"],
  ["email.suppressed", "suppressed"],
  ["email.clicked", "clicked"],
  ["email.opened", "opened"],
  ["email.delivered", "delivered"],
  ["email.delivery_delayed", "delayed"],
  ["email.sent", "sent"],
]

/** One email's status from the types of all its events, or null when there are none */
export function deliveryStatus(types: Iterable<string>): DeliveryStatus | null {
  const seen = new Set(types)
  for (const [type, status] of RANK) if (seen.has(type)) return status
  return null
}

/** The statuses that mean it didn't reach the inbox, and won't */
export const UNDELIVERED: readonly DeliveryStatus[] = ["complained", "bounced", "failed", "suppressed"]

export const isUndelivered = (status: DeliveryStatus | null | undefined) => Boolean(status && UNDELIVERED.includes(status))

export const DELIVERY_LABEL: Record<DeliveryStatus, { label: string; tone: "success" | "warning" | "danger" | "neutral"; hint: string }> = {
  delivered: { label: "Delivered", tone: "success", hint: "The receiving mail server accepted it (it may still have gone to spam)" },
  opened: { label: "Opened", tone: "success", hint: "Delivered and opened" },
  clicked: { label: "Clicked", tone: "success", hint: "Delivered, and a link in it was clicked" },
  sent: { label: "Sent", tone: "neutral", hint: "Resend took it; no delivery report yet" },
  delayed: { label: "Delayed", tone: "warning", hint: "The receiving server hasn't accepted it yet; Resend keeps trying for up to 14 hours" },
  bounced: { label: "Bounced", tone: "danger", hint: "The address doesn't take mail (or its mailbox refused this one)" },
  complained: { label: "Marked as spam", tone: "danger", hint: "The recipient reported it as spam; Resend won't send to them again" },
  failed: { label: "Failed", tone: "danger", hint: "Resend couldn't send it (for example, the daily limit was reached)" },
  suppressed: { label: "Suppressed", tone: "danger", hint: "Not sent: the address bounced or complained before, so it's on Resend's suppression list" },
}
