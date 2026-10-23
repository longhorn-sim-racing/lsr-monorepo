import { z } from "zod"
import { DELIVERY_LABEL, deliveryStatus, type DeliveryStatus } from "@/lib/email-delivery"
import { prisma } from "@/server/db"
import { resendConnector } from "@/server/connectors/resend/connector"
import { bouncedRecipients, deliveryFor, emailsTo, emailTimeline, eventReason, PRIVATE_RECRUITING_EMAIL, subjectsFor } from "@/server/connectors/resend/delivery"
import { forModelWithLists, plural, tableDisplay } from "./display"
import { notConnected, sourceConnection } from "./source-connection"
import { centralDate, ct } from "./time"
import type { JackTool } from "./types"

/**
 * email_delivery (#188, design §7.1, §12.4): what happened to the club's email after Resend took it,
 * from the delivery events Resend sends us. A send (an announcement, a reminder) with how many were
 * delivered or bounced; one email's timeline; one recipient's recent mail (only when an officer named
 * them); the addresses that bounce. Recruiting mail to officer and admin applicants shows only that it
 * was recruiting mail (design §3.2).
 */

const DAY_MS = 86_400_000
const OFFICER_ROLES = ["officer", "admin"]
const NOT_OFFICER_APPLICANT = { application: { user: { roles: { none: { role: { key: { in: OFFICER_ROLES } } } } } } }

const input = z.object({
  view: z
    .enum(["sends", "email", "recipient", "bounces"])
    .default("sends")
    .describe(
      "sends: recent email sends (each notification title per day, and recruiting emails by template) with how many were delivered, bounced and so on. email: one email's events (needs id). recipient: one person's recent mail (needs recipient). bounces: addresses whose mail bounced, was marked as spam, failed or was suppressed",
    ),
  match: z.string().trim().max(120).optional().describe("sends: only notifications whose title contains this, e.g. GM 2"),
  id: z.string().trim().max(200).optional().describe("email: a notification's id, a recruiting email's id, or Resend's email id"),
  recipient: z.string().trim().max(320).optional().describe("recipient: an email address or a member's @handle. Only when an officer named this person"),
  days: z.number().int().min(1).max(365).default(14).describe("How many days back to look"),
  limit: z.number().int().min(1).max(100).default(25).describe("Most rows to list"),
})

type Counts = Partial<Record<DeliveryStatus | "noReport" | "notSent", number>>

const bump = (counts: Counts, key: keyof Counts) => (counts[key] = (counts[key] ?? 0) + 1)

/** "delivered 45, bounced 2, no report yet 1" */
const countsText = (counts: Counts) =>
  Object.entries(counts)
    .map(([key, n]) => `${key === "noReport" ? "no report yet" : key === "notSent" ? "never sent" : DELIVERY_LABEL[key as DeliveryStatus].label.toLowerCase()} ${n}`)
    .join(", ")

async function sendsView(since: Date, match: string | undefined, limit: number) {
  const [notifications, recruiting] = await Promise.all([
    prisma.notification.findMany({
      where: { channel: "EMAIL", OR: [{ sentAt: { gte: since } }, { status: "FAILED", createdAt: { gte: since } }], ...(match ? { title: { contains: match, mode: "insensitive" } } : {}) },
      orderBy: { createdAt: "desc" },
      take: 5_000,
      select: { title: true, type: true, status: true, sentAt: true, createdAt: true, emailMessageId: true },
    }),
    match ? [] : prisma.applicationEmail.findMany({ where: { createdAt: { gte: since }, ...NOT_OFFICER_APPLICANT }, take: 5_000, select: { template: true, status: true, sentAt: true, createdAt: true, resendMessageId: true } }),
  ])
  const delivery = await deliveryFor([...notifications.map((n) => n.emailMessageId), ...recruiting.map((r) => r.resendMessageId)])

  const groups = new Map<string, { what: string; kind: string; day: string; emails: number; counts: Counts }>()
  const add = (key: string, init: { what: string; kind: string; day: string }, resendId: string | null, sent: boolean) => {
    const group = groups.get(key) ?? { ...init, emails: 0, counts: {} }
    group.emails += 1
    bump(group.counts, !sent ? "notSent" : (resendId && delivery.get(resendId)?.status) || "noReport")
    groups.set(key, group)
  }
  for (const n of notifications) {
    const day = centralDate(n.sentAt ?? n.createdAt)
    add(`n|${n.type}|${n.title}|${day}`, { what: n.title, kind: n.type, day }, n.emailMessageId, n.status === "SENT" && Boolean(n.emailMessageId))
  }
  for (const r of recruiting) {
    const day = centralDate(r.sentAt ?? r.createdAt)
    add(`r|${r.template}|${day}`, { what: `Recruiting: ${r.template.toLowerCase().replace(/_/g, " ")}`, kind: "RECRUITING", day }, r.resendMessageId, r.status === "SENT" && Boolean(r.resendMessageId))
  }
  const rows = [...groups.values()].sort((a, b) => b.day.localeCompare(a.day) || b.emails - a.emails)
  return { rows, shown: rows.slice(0, limit) }
}

export const emailDeliveryTool: JackTool<z.infer<typeof input>> = {
  name: "email_delivery",
  description:
    "Email delivery (Resend): whether the club's emails reached people. sends: each recent send (a notification or announcement title, per day; recruiting emails by template) with how many were delivered, bounced, marked as spam, delayed or never sent. email: one email's events. recipient: one person's recent emails and their status, only when an officer named the person or address. bounces: addresses whose mail bounced or was refused, with the reason and whether a later email got through. \"Delivered\" means the receiving server accepted it, not that it was read (it may be in spam). Opens and clicks are only known if tracking is on.",
  input,
  deferred: true,
  async run({ view, match, id, recipient, days, limit }) {
    const connection = await sourceConnection(resendConnector, "Email delivery tracking")
    if (!connection.connected && !(await prisma.emailEvent.findFirst({ select: { id: true } }))) return notConnected(connection, "email delivery data")
    const now = new Date()
    const since = new Date(now.getTime() - days * DAY_MS)
    const base = { connection: connection.note, window: { days, since: ct(since) }, meaning: "Delivered = the receiving mail server accepted it (it may still be in spam). Sent = Resend took it and no report has come back yet." }

    if (view === "email") {
      if (!id) return { isError: true, forModel: "view email needs id: a notification's id, a recruiting email's id, or Resend's email id.", label: "Email lookup failed", displays: [] }
      const [notification, recruitingEmail] = await Promise.all([
        prisma.notification.findUnique({ where: { id }, select: { emailMessageId: true, status: true, emailError: true, title: true } }).catch(() => null),
        prisma.applicationEmail
          .findUnique({ where: { id }, select: { resendMessageId: true, status: true, error: true, application: { select: { user: { select: { roles: { select: { role: { select: { key: true } } } } } } } } } })
          .catch(() => null),
      ])
      if (recruitingEmail?.application.user.roles.some((r) => OFFICER_ROLES.includes(r.role.key))) {
        return { forModel: JSON.stringify({ ...base, email: PRIVATE_RECRUITING_EMAIL.subject }), label: "Looked up a private recruiting email", displays: [{ kind: "note", text: "That recruiting email is private." }] }
      }
      const resendId = notification?.emailMessageId ?? recruitingEmail?.resendMessageId ?? (notification || recruitingEmail ? null : id)
      if (!resendId) {
        const status = notification?.status ?? recruitingEmail?.status
        const error = notification?.emailError ?? recruitingEmail?.error
        return { forModel: JSON.stringify({ ...base, email: { sent: false, status, ...(error ? { error } : {}) }, note: "It never reached Resend, so there's no delivery report." }), label: "Looked up an email (never sent)", displays: [{ kind: "note", text: `Never sent${error ? `: ${error}` : ""}.` }] }
      }
      const [events, subjects] = await Promise.all([emailTimeline(resendId), subjectsFor([resendId], { hideOfficerApplicants: true })])
      if (!events.length) return { forModel: JSON.stringify({ ...base, email: { resendId, events: [] }, note: "No delivery events for this email (none came, or it's older than what's kept)." }), label: "Looked up an email (no events)", displays: [{ kind: "note", text: "No delivery events for this email." }] }
      const status = deliveryStatus(events.map((e) => e.type))!
      const subject = subjects.get(resendId)
      return {
        forModel: forModelWithLists({ ...base, email: { resendId, status: DELIVERY_LABEL[status].label, means: DELIVERY_LABEL[status].hint, to: events[0].recipient, ...(subject ? { what: subject.subject } : {}) } }, [
          { key: "events", items: events.map((e) => ({ type: e.type.replace("email.", ""), at: ct(e.occurredAt), ...(eventReason(e.detail) ? { reason: eventReason(e.detail) } : {}) })) },
        ]),
        label: `Looked up an email (${DELIVERY_LABEL[status].label.toLowerCase()})`,
        displays: [tableDisplay(events, [{ header: "Event", value: (e) => e.type.replace("email.", "").replace(/_/g, " ") }, { header: "When (CT)", value: (e) => ct(e.occurredAt) }, { header: "Detail", value: (e) => eventReason(e.detail) }], subject?.subject)],
      }
    }

    if (view === "recipient") {
      if (!recipient) return { isError: true, forModel: "view recipient needs recipient: the address or @handle an officer named.", label: "Recipient lookup failed", displays: [] }
      let address = recipient.toLowerCase()
      if (!address.includes("@") || address.startsWith("@")) {
        const handle = address.replace(/^@/, "")
        const user = await prisma.user.findFirst({ where: { handle: { equals: handle, mode: "insensitive" } }, select: { email: true, displayName: true } })
        if (!user) return { isError: true, forModel: `No member with the handle @${handle}. Give an email address or a handle from club_members.`, label: "Recipient lookup failed", displays: [] }
        address = user.email.toLowerCase()
      }
      const emails = await emailsTo(address, since, limit, { hideOfficerApplicants: true })
      const rows = emails.map((e) => ({ what: e.subject?.subject ?? "An email the app doesn't know (sent from the Resend dashboard or elsewhere)", sent: ct(e.sentAt), status: DELIVERY_LABEL[e.status].label, ...(e.reason ? { reason: e.reason } : {}) }))
      return {
        forModel: forModelWithLists({ ...base, recipient: address, emails: emails.length }, [{ key: "list", items: rows }]),
        label: `Looked up email to one recipient (${plural(emails.length, "email")} in ${days} days)`,
        displays: rows.length ? [tableDisplay(rows, [{ header: "Email", value: (r) => r.what }, { header: "Sent (CT)", value: (r) => r.sent }, { header: "Status", value: (r) => r.status }])] : [{ kind: "note", text: `No email to them in the last ${days} days.` }],
      }
    }

    if (view === "bounces") {
      const { rows, total } = await bouncedRecipients(since, limit, { hideOfficerApplicants: true })
      const items = rows.map((r) => ({
        recipient: r.recipient,
        ...(r.member ? { member: r.member.displayName } : {}),
        status: DELIVERY_LABEL[r.lastStatus].label,
        last: ct(r.lastAt),
        emailsNotDelivered: r.failed,
        ...(r.reason ? { reason: r.reason } : {}),
        ...(r.lastEmail ? { lastEmail: r.lastEmail.subject } : {}),
        ...(r.deliveredSince ? { laterEmailDelivered: true } : {}),
      }))
      return {
        forModel: forModelWithLists({ ...base, addresses: total, where: "Notifications → Delivery lists them too" }, [{ key: "bounced", items }]),
        label: `Looked up bounces (${plural(total, "address", "addresses")} in ${days} days)`,
        displays: items.length
          ? [tableDisplay(items, [{ header: "Address", value: (r) => r.recipient }, { header: "Member", value: (r) => r.member ?? null }, { header: "Status", value: (r) => r.status }, { header: "Last (CT)", value: (r) => r.last }])]
          : [{ kind: "note", text: `No bounces in the last ${days} days.` }],
      }
    }

    const { rows, shown } = await sendsView(since, match, limit)
    const items = shown.map((g) => ({ email: g.what, type: g.kind, day: g.day, emails: g.emails, outcome: countsText(g.counts) }))
    return {
      forModel: forModelWithLists({ ...base, sends: rows.length, ...(match ? { match } : {}), dayIs: "Central date the email went out" }, [{ key: "list", items, whenTrimmed: "Narrow it with match or fewer days." }]),
      label: `Looked up email delivery (${plural(rows.length, "send")} in ${days} days)`,
      displays: items.length ? [tableDisplay(items, [{ header: "Email", value: (r) => r.email }, { header: "Day", value: (r) => r.day }, { header: "Emails", value: (r) => r.emails }, { header: "Outcome", value: (r) => r.outcome }])] : [{ kind: "note", text: `No emails sent in the last ${days} days${match ? ` matching "${match}"` : ""}.` }],
    }
  },
}
