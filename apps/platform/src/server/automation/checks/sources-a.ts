import { bouncedRecipients } from "@/server/connectors/resend/delivery"
import type { DigestCheck, DigestCheckResult } from "../types"

/** Digest and Overview "needs attention" checks from the sources-a track (design §11.2) */

const DAY_MS = 86_400_000
/** How far back the bounce check looks */
export const BOUNCE_WINDOW_DAYS = 7

/**
 * Addresses whose email bounced, was marked as spam, failed or was suppressed in the last week, grouped
 * by the email that failed. Items name the email (a notification's title), never an address; the
 * bounce list on Notifications has the rest. Spam complaints make it urgent: Resend pauses accounts
 * that pass 0.08%.
 */
export const emailBounces: DigestCheck = {
  id: "email.bounces",
  label: "Email that didn't arrive",
  href: "/admin/notifications?tab=delivery",
  order: 70,
  async run({ now }): Promise<DigestCheckResult> {
    const { rows, total } = await bouncedRecipients(new Date(now.getTime() - BOUNCE_WINDOW_DAYS * DAY_MS), 500, { hideOfficerApplicants: true })
    const complaints = rows.filter((r) => r.lastStatus === "complained").length
    const byEmail = new Map<string, { title: string; addresses: number; last: Date }>()
    for (const row of rows) {
      const title = row.lastEmail?.subject ?? "An email sent outside the site"
      const entry = byEmail.get(title) ?? { title, addresses: 0, last: row.lastAt }
      entry.addresses += 1
      if (row.lastAt > entry.last) entry.last = row.lastAt
      byEmail.set(title, entry)
    }
    return {
      count: total,
      severity: complaints ? "danger" : total ? "warning" : "info",
      items: [...byEmail.values()]
        .sort((a, b) => b.addresses - a.addresses || b.last.getTime() - a.last.getTime())
        .map((entry) => ({
          title: `${entry.title}: ${entry.addresses} ${entry.addresses === 1 ? "address" : "addresses"} didn't get it`,
          href: "/admin/notifications?tab=delivery",
          detail: `Last ${entry.last.toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric" })}`,
        })),
      // Items are emails (the count is addresses), every one listed
      moreItems: 0,
    }
  },
}

export const CHECKS: DigestCheck[] = [emailBounces]
