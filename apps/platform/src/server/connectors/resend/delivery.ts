import { deliveryStatus, isUndelivered, type DeliveryStatus } from "@/lib/email-delivery"
import { prisma } from "@/server/db"

/**
 * Reads email delivery from EmailEvent (design §12.4), for the Notifications and Recruiting pages,
 * Jack's email_delivery tool and the bounce check. Each email's status comes from all its events
 * (deliveryStatus), whatever order they arrived in. EmailEvent holds addresses: officers only.
 */

export type EmailDelivery = {
  status: DeliveryStatus
  /** Its newest event */
  at: Date
  /** Why it bounced, failed or was suppressed, when Resend said */
  reason: string | null
}

/** Event types that mean an email didn't arrive (the UNDELIVERED statuses) */
export const FAILURE_TYPES = ["email.complained", "email.bounced", "email.failed", "email.suppressed"]
const ARRIVED_TYPES = ["email.delivered", "email.opened", "email.clicked"]

type EventRow = { resendId: string; recipient: string; type: string; occurredAt: Date; detail: unknown }

/** The reason in an event's detail: a bounce's message, a failure's reason, a suppression's message */
export function eventReason(detail: unknown): string | null {
  if (!detail || typeof detail !== "object") return null
  const d = detail as Record<string, unknown>
  const parts = [d.bounceType, d.subType].filter((p): p is string => typeof p === "string" && p !== "General")
  const message = typeof d.message === "string" ? d.message : typeof d.reason === "string" ? d.reason.replace(/_/g, " ") : null
  const text = [parts.join(" "), message].filter(Boolean).join(": ")
  return text || null
}

/** Each email's delivery from its events (pure) */
export function summarizeEvents(events: EventRow[]): Map<string, EmailDelivery & { recipient: string; firstAt: Date }> {
  const byEmail = new Map<string, EventRow[]>()
  for (const event of events) byEmail.set(event.resendId, [...(byEmail.get(event.resendId) ?? []), event])
  const result = new Map<string, EmailDelivery & { recipient: string; firstAt: Date }>()
  for (const [resendId, list] of byEmail) {
    const status = deliveryStatus(list.map((e) => e.type))
    if (!status) continue
    const sorted = [...list].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
    const failure = [...sorted].reverse().find((e) => FAILURE_TYPES.includes(e.type) || e.type === "email.delivery_delayed")
    result.set(resendId, {
      status,
      at: sorted[sorted.length - 1].occurredAt,
      firstAt: sorted[0].occurredAt,
      recipient: sorted.find((e) => e.recipient)?.recipient ?? "",
      reason: failure ? eventReason(failure.detail) : null,
    })
  }
  return result
}

const CHUNK = 1_000

/** The delivery of each Resend email id that has events; ids without any are left out */
export async function deliveryFor(resendIds: (string | null | undefined)[]): Promise<Map<string, EmailDelivery>> {
  const ids = [...new Set(resendIds.filter((id): id is string => Boolean(id)))]
  const events: EventRow[] = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    events.push(...(await prisma.emailEvent.findMany({ where: { resendId: { in: ids.slice(i, i + CHUNK) } }, select: { resendId: true, recipient: true, type: true, occurredAt: true, detail: true } })))
  }
  return new Map([...summarizeEvents(events)].map(([id, d]) => [id, { status: d.status, at: d.at, reason: d.reason }]))
}

/** What an email was, from the app's own records: a notification's title or a recruiting email's subject */
export type EmailSubject = { kind: "notification" | "recruiting"; subject: string; detail: string | null; link: string | null }

/** Who counts as an officer applicant, whose recruiting mail Jack keeps private (design §3.2) */
const OFFICER_ROLES = ["officer", "admin"]

/** The recruiting email Jack shows in place of one to an officer or admin applicant: its subject and template would give a decision away */
export const PRIVATE_RECRUITING_EMAIL: EmailSubject = { kind: "recruiting", subject: "A recruiting email (private: the applicant is an officer or admin)", detail: null, link: null }

export type SubjectOptions = {
  /** Jack's rule: a recruiting email to an applicant who is an officer or admin shows only that it's a recruiting email */
  hideOfficerApplicants?: boolean
}

export async function subjectsFor(resendIds: string[], options: SubjectOptions = {}): Promise<Map<string, EmailSubject>> {
  if (!resendIds.length) return new Map()
  const [notifications, recruiting] = await Promise.all([
    prisma.notification.findMany({ where: { emailMessageId: { in: resendIds } }, select: { emailMessageId: true, title: true, type: true } }),
    prisma.applicationEmail.findMany({
      where: { resendMessageId: { in: resendIds } },
      select: { resendMessageId: true, subject: true, template: true, applicationId: true, application: { select: { user: { select: { roles: { select: { role: { select: { key: true } } } } } } } } },
    }),
  ])
  const subjects = new Map<string, EmailSubject>()
  for (const n of notifications) if (n.emailMessageId) subjects.set(n.emailMessageId, { kind: "notification", subject: n.title, detail: n.type, link: "/admin/notifications" })
  for (const r of recruiting) {
    if (!r.resendMessageId) continue
    const officer = r.application.user.roles.some((role) => OFFICER_ROLES.includes(role.role.key))
    subjects.set(r.resendMessageId, options.hideOfficerApplicants && officer ? PRIVATE_RECRUITING_EMAIL : { kind: "recruiting", subject: r.subject, detail: r.template, link: `/admin/recruiting/${r.applicationId}` })
  }
  return subjects
}

export type BouncedRecipient = {
  recipient: string
  /** Emails to them that didn't arrive in the window */
  failed: number
  lastStatus: DeliveryStatus
  lastAt: Date
  reason: string | null
  /** A later email to them did arrive, so the address may be fine now */
  deliveredSince: boolean
  /** The email that last failed */
  lastEmail: EmailSubject | null
  member: { id: string; displayName: string } | null
}

/** Addresses whose email bounced, was marked as spam, failed or was suppressed since `since`, latest first */
export async function bouncedRecipients(since: Date, limit = 100, options: SubjectOptions = {}): Promise<{ rows: BouncedRecipient[]; total: number }> {
  const failures = await prisma.emailEvent.findMany({
    where: { type: { in: FAILURE_TYPES }, occurredAt: { gte: since } },
    orderBy: { occurredAt: "desc" },
    take: 5_000,
    select: { resendId: true, recipient: true, type: true, occurredAt: true, detail: true },
  })
  // An email's status comes from all its events, not only the failure
  const delivery = summarizeEvents(
    await prisma.emailEvent.findMany({ where: { resendId: { in: [...new Set(failures.map((f) => f.resendId))] } }, select: { resendId: true, recipient: true, type: true, occurredAt: true, detail: true } }),
  )
  const byRecipient = new Map<string, { emails: Set<string>; last: { resendId: string; status: DeliveryStatus; at: Date; reason: string | null } }>()
  for (const f of failures) {
    const d = delivery.get(f.resendId)
    if (!f.recipient || !d || !isUndelivered(d.status)) continue
    const entry = byRecipient.get(f.recipient) ?? { emails: new Set<string>(), last: { resendId: f.resendId, status: d.status, at: d.at, reason: d.reason } }
    entry.emails.add(f.resendId)
    if (d.at > entry.last.at) entry.last = { resendId: f.resendId, status: d.status, at: d.at, reason: d.reason }
    byRecipient.set(f.recipient, entry)
  }

  const recipients = [...byRecipient.entries()].sort((a, b) => b[1].last.at.getTime() - a[1].last.at.getTime())
  const shown = recipients.slice(0, limit)
  const addresses = shown.map(([recipient]) => recipient)
  const [arrived, members, subjects] = await Promise.all([
    addresses.length ? prisma.emailEvent.findMany({ where: { recipient: { in: addresses }, type: { in: ARRIVED_TYPES }, occurredAt: { gte: since } }, select: { recipient: true, occurredAt: true } }) : [],
    addresses.length ? prisma.user.findMany({ where: { email: { in: addresses, mode: "insensitive" } }, select: { id: true, displayName: true, email: true } }) : [],
    subjectsFor(shown.map(([, entry]) => entry.last.resendId), options),
  ])
  const memberByEmail = new Map(members.map((m) => [m.email.toLowerCase(), { id: m.id, displayName: m.displayName }]))

  return {
    total: recipients.length,
    rows: shown.map(([recipient, entry]) => ({
      recipient,
      failed: entry.emails.size,
      lastStatus: entry.last.status,
      lastAt: entry.last.at,
      reason: entry.last.reason,
      deliveredSince: arrived.some((a) => a.recipient === recipient && a.occurredAt > entry.last.at),
      lastEmail: subjects.get(entry.last.resendId) ?? null,
      member: memberByEmail.get(recipient) ?? null,
    })),
  }
}

/** How the emails with events since `since` turned out, by status */
export async function deliveryCounts(since: Date): Promise<{ emails: number; byStatus: Record<DeliveryStatus, number> }> {
  const ids = await prisma.emailEvent.findMany({ where: { occurredAt: { gte: since } }, distinct: ["resendId"], select: { resendId: true }, take: 20_000 })
  const delivery = await deliveryFor(ids.map((row) => row.resendId))
  const byStatus = { complained: 0, bounced: 0, failed: 0, suppressed: 0, clicked: 0, opened: 0, delivered: 0, delayed: 0, sent: 0 } satisfies Record<DeliveryStatus, number>
  for (const d of delivery.values()) byStatus[d.status] += 1
  return { emails: delivery.size, byStatus }
}

export type RecipientEmail = EmailDelivery & { resendId: string; sentAt: Date; subject: EmailSubject | null }

/** The latest emails to one address, newest first, with their delivery */
export async function emailsTo(recipient: string, since: Date, limit = 25, options: SubjectOptions = {}): Promise<RecipientEmail[]> {
  const events = await prisma.emailEvent.findMany({
    where: { recipient: recipient.trim().toLowerCase(), occurredAt: { gte: since } },
    orderBy: { occurredAt: "desc" },
    take: 2_000,
    select: { resendId: true, recipient: true, type: true, occurredAt: true, detail: true },
  })
  const delivery = [...summarizeEvents(events)].sort((a, b) => b[1].firstAt.getTime() - a[1].firstAt.getTime()).slice(0, limit)
  const subjects = await subjectsFor(delivery.map(([id]) => id), options)
  return delivery.map(([resendId, d]) => ({ resendId, status: d.status, at: d.at, reason: d.reason, sentAt: d.firstAt, subject: subjects.get(resendId) ?? null }))
}

export type RecruitingDelivery = {
  /** Sent emails of the round that didn't arrive (or are still delayed), newest first */
  problems: {
    id: string
    template: string
    subject: string
    toEmail: string
    createdAt: Date
    applicationId: string
    applicantName: string | null
    delivery: EmailDelivery
  }[]
  /** The round's sent emails by what Resend reported */
  summary: { sent: number; arrived: number; undelivered: number; delayed: number; noReport: number }
}

/** How a recruiting round's sent emails turned out (Recruiting → Emails). The console shows officers every application's mail */
export async function recruitingDelivery(cycleId: string): Promise<RecruitingDelivery> {
  const sent = await prisma.applicationEmail.findMany({
    where: { status: "SENT", resendMessageId: { not: null }, application: { cycleId } },
    orderBy: { createdAt: "desc" },
    take: 2_000,
    select: { id: true, template: true, subject: true, toEmail: true, createdAt: true, resendMessageId: true, application: { select: { id: true, fullName: true } } },
  })
  const delivery = await deliveryFor(sent.map((e) => e.resendMessageId))
  const summary = { sent: sent.length, arrived: 0, undelivered: 0, delayed: 0, noReport: 0 }
  const problems: RecruitingDelivery["problems"] = []
  for (const email of sent) {
    const d = delivery.get(email.resendMessageId!)
    if (!d || d.status === "sent") summary.noReport += 1
    else if (isUndelivered(d.status)) summary.undelivered += 1
    else if (d.status === "delayed") summary.delayed += 1
    else summary.arrived += 1
    if (d && (isUndelivered(d.status) || d.status === "delayed")) {
      problems.push({ id: email.id, template: email.template, subject: email.subject, toEmail: email.toEmail, createdAt: email.createdAt, applicationId: email.application.id, applicantName: email.application.fullName, delivery: d })
    }
  }
  return { problems, summary }
}

/** Every event of one email, oldest first */
export async function emailTimeline(resendId: string) {
  return prisma.emailEvent.findMany({ where: { resendId }, orderBy: { occurredAt: "asc" }, select: { type: true, occurredAt: true, detail: true, recipient: true } })
}
