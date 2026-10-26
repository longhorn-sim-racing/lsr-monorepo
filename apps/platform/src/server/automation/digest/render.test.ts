import { describe, expect, it, vi } from "vitest"

vi.mock("../registry", () => ({ DIGEST_CHECKS: [] }))

import { noteLink } from "@/lib/jack/proposals"
import type { CheckOutcome, DigestReport } from "../run-checks"
import { consoleUrl, DISCORD_MAX_CHARS, discordDigestMessage, discordDigestText, roomDigestText, teamsDigestCard } from "./render"

const AT = new Date("2026-10-26T14:00:00Z") // Mon, Oct 26, 9 AM Central
const SITE = "https://www.longhornsimracing.org"

function outcome(id: string, label: string, href: string, order: number, result: CheckOutcome["result"], error: string | null = null): CheckOutcome {
  return { check: { id, label, href, order }, result, error }
}

/** A week with something of everything, including personal data the outside copies must never carry */
const report: DigestReport = {
  at: AT,
  outcomes: [
    outcome("action_items.overdue", "Overdue action items", "/admin/action-items?status=overdue", 20, {
      count: 4,
      severity: "warning",
      items: [
        { title: "Dylan Example: 2 overdue", href: "/admin/action-items?owner=dylan&status=overdue", detail: "Oldest due 2026-10-10 (16 days ago)" },
        { title: "No owner: 1 overdue", href: "/admin/action-items?owner=none&status=overdue" },
        { title: "Alex Example: 1 overdue", href: "/admin/action-items?owner=alex&status=overdue" },
      ],
      // Items are owners: the check lists them all
      moreItems: 0,
    }),
    outcome("jack.spend", "Jack's monthly budget", "/admin/jack/usage", 95, { count: 1, severity: "danger", items: [{ title: "October: $50.20 of $50 spent", href: "/admin/jack/usage" }] }),
    outcome("email.bounces", "Email that didn't arrive", "/admin/notifications?tab=delivery", 70, {
      count: 6,
      severity: "info",
      items: [
        { title: "GM 2 is tonight: 4 addresses didn't get it", href: "/admin/notifications?tab=delivery" },
        { title: "@everyone check <@123456789012345678>", href: "/admin/notifications?tab=delivery" },
        { title: "x", href: "/admin" },
        { title: "y", href: "/admin" },
      ],
      // Items are emails, the count is addresses
      moreItems: 0,
    }),
    outcome("knowledge.stale", "Knowledge over 6 months old", "/admin/knowledge?view=stale", 81, { count: 0, severity: "info", items: [] }),
    outcome("twitch.attention", "Twitch connection", "/admin/streams", 60, null, "Twitch answered 401 on /streams"),
  ],
}

describe("the room's copy", () => {
  const text = roomDigestText(report, { setUpBy: "Gray", askSummary: true })
  const lines = text.split("\n")

  it("leads with the day, who set it up and how much needs attention, linking the Overview", () => {
    expect(lines[0]).toBe("Weekly digest for Mon, Oct 26 (set up by Gray): 11 things need attention → /admin")
    expect(noteLink(lines[0])).toEqual({ text: "Weekly digest for Mon, Oct 26 (set up by Gray): 11 things need attention", path: "/admin" })
  })

  it("groups the checks most urgent first, with their first items, each line linking where it's dealt with", () => {
    expect(text).toBe(
      [
        "Weekly digest for Mon, Oct 26 (set up by Gray): 11 things need attention → /admin",
        "",
        "Urgent",
        "- Jack's monthly budget: 1 → /admin/jack/usage",
        "  - October: $50.20 of $50 spent → /admin/jack/usage",
        "",
        "Needs attention",
        "- Overdue action items: 4 → /admin/action-items?status=overdue",
        "  - Dylan Example: 2 overdue (Oldest due 2026-10-10 (16 days ago)) → /admin/action-items?owner=dylan&status=overdue",
        "  - No owner: 1 overdue → /admin/action-items?owner=none&status=overdue",
        "  - Alex Example: 1 overdue → /admin/action-items?owner=alex&status=overdue",
        "",
        "For your information",
        "- Email that didn't arrive: 6 → /admin/notifications?tab=delivery",
        "  - GM 2 is tonight: 4 addresses didn't get it → /admin/notifications?tab=delivery",
        "  - @everyone check <@123456789012345678> → /admin/notifications?tab=delivery",
        "  - x → /admin",
        "  - and 1 more",
        "",
        "Couldn't check: Twitch connection",
        "",
        "Jack: sum this up for the officers in at most four sentences, most urgent first: pick what matters most rather than going through every line, and use only what's listed here.",
      ].join("\n"),
    )
    // Every item line opens its page in the room
    for (const line of lines.filter((l) => l.startsWith("- ") || (l.startsWith("  - ") && !l.includes("more")))) expect(noteLink(line), line).not.toBeNull()
  })

  it("counts \"and N more\" in the items' units: the count past what's shown, or the check's own moreItems", () => {
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Proposal ${i + 1}`, href: `/admin/jack/proposals/p-${i + 1}` }))
    const more: DigestReport = {
      at: AT,
      outcomes: [
        // 12 pending, the check lists its first 5, the room shows 3
        outcome("proposals.pending", "Proposals waiting for an officer", "/admin/jack/proposals", 10, { count: 12, severity: "warning", items: items(5) }),
        // 9 overdue items over 6 owners, the check lists 4 owners
        outcome("action_items.overdue", "Overdue action items", "/admin/action-items?status=overdue", 20, { count: 9, severity: "warning", items: items(4), moreItems: 2 }),
        // 2 bounced addresses on 1 email: nothing more
        outcome("email.bounces", "Email that didn't arrive", "/admin/notifications?tab=delivery", 70, { count: 2, severity: "warning", items: items(1), moreItems: 0 }),
      ],
    }
    const lines = roomDigestText(more, { setUpBy: "Gray", askSummary: false }).split("\n")
    expect(lines.filter((line) => line.includes("more"))).toEqual(["  - and 9 more", "  - and 3 more"])
  })

  it("never carries a check's error text, and asks for no summary unless told to or when nothing needs attention", () => {
    expect(text).not.toContain("401")
    expect(roomDigestText(report, { setUpBy: "Gray", askSummary: false })).not.toContain("Jack: sum this up")
    const quiet: DigestReport = { at: AT, outcomes: [outcome("knowledge.stale", "Knowledge", "/admin/knowledge", 81, { count: 0, severity: "info", items: [] })] }
    expect(roomDigestText(quiet, { setUpBy: "Gray", askSummary: true })).toBe("Weekly digest for Mon, Oct 26 (set up by Gray): nothing needs attention → /admin")
  })
})

describe("Discord's and Teams' copies", () => {
  const discord = discordDigestText(report, SITE)
  const card = teamsDigestCard(report, SITE)

  it("carry each check's name, count and console link, and nothing from its items", () => {
    expect(discord).toBe(
      [
        "**LSR weekly digest** · Mon, Oct 26",
        "11 things need attention in the officer console:",
        "• Jack's monthly budget: 1 <https://www.longhornsimracing.org/admin/jack/usage>",
        "• Overdue action items: 4 <https://www.longhornsimracing.org/admin/action-items?status=overdue>",
        "• Email that didn't arrive: 6 <https://www.longhornsimracing.org/admin/notifications?tab=delivery>",
        "(1 check couldn't run; the console has the details.)",
      ].join("\n"),
    )
    for (const copy of [discord, JSON.stringify(card)]) {
      expect(copy).not.toMatch(/Dylan|Alex|GM 2|@everyone|<@\d|October: \$|401|owner=/)
    }
  })

  it("ping nobody and don't unfurl links", () => {
    const message = discordDigestMessage(report, SITE)
    expect(message.allowed_mentions).toEqual({ parse: [] })
    expect(message.flags).toBe(4)
    expect(message.content).not.toContain("@")
  })

  it("fit Discord's limit, pointing to the console for the rest", () => {
    const many: DigestReport = {
      at: AT,
      outcomes: Array.from({ length: 60 }, (_, i) => outcome(`check.${i}`, `A long check label number ${i} that takes up room`, `/admin/somewhere/quite/long/${i}`, i, { count: i + 1, severity: "warning", items: [] })),
    }
    const text = discordDigestText(many, SITE)
    expect(text.length).toBeLessThanOrEqual(DISCORD_MAX_CHARS)
    expect(text).toMatch(/…and \d+ more <https:\/\/www\.longhornsimracing\.org\/admin>$/)
  })

  it("send Teams one Adaptive Card the Workflows webhook takes, with a button to the console", () => {
    expect(card.type).toBe("message")
    expect(card.attachments).toHaveLength(1)
    const [attachment] = card.attachments
    expect(attachment.contentType).toBe("application/vnd.microsoft.card.adaptive")
    expect(attachment.content).toMatchObject({ type: "AdaptiveCard", version: "1.2", actions: [{ type: "Action.OpenUrl", url: `${SITE}/admin` }] })
    expect(attachment.content.body.map((block) => block.text)).toEqual([
      "LSR weekly digest · Mon, Oct 26",
      "11 things need attention in the officer console.",
      "- [Jack's monthly budget](https://www.longhornsimracing.org/admin/jack/usage): 1",
      "- [Overdue action items](https://www.longhornsimracing.org/admin/action-items?status=overdue): 4",
      "- [Email that didn't arrive](https://www.longhornsimracing.org/admin/notifications?tab=delivery): 6",
      "1 check couldn't run; the console has the details.",
    ])
  })

  it("make full links from console paths", () => {
    expect(consoleUrl("https://example.org/", "/admin/jobs")).toBe("https://example.org/admin/jobs")
    expect(consoleUrl("https://example.org", "admin")).toBe("https://example.org/admin")
  })
})
