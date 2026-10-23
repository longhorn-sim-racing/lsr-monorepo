import { formatInTimeZone } from "date-fns-tz"
import { DEFAULT_TIMEZONE } from "@/lib/dates"
import { attentionCount, failedChecks, needingAttention, type DigestReport } from "../run-checks"

/**
 * The weekly digest, rendered from a template (design §11.2): no model writes any of it.
 *
 * - The room gets everything: each check that found something, with its first few items, as a note
 *   whose lines end in a console path the room links.
 * - Discord and Teams get each check's label, its count and a link into the console, and nothing else:
 *   no items (they can name people), no error text, no outside text. Labels are fixed text from the
 *   checks' code. Discord's copy also strips anything that could ping (allowed_mentions is empty too).
 */

/** Items per check in the room's copy; the count covers the rest */
export const ROOM_ITEMS_PER_CHECK = 3
/** Discord's limit on a message is 2,000 characters; this leaves room */
export const DISCORD_MAX_CHARS = 1_900

const SECTIONS = [
  { severity: "danger", heading: "Urgent" },
  { severity: "warning", heading: "Needs attention" },
  { severity: "info", heading: "For your information" },
] as const

/** "Mon, Oct 26" */
export function digestDay(at: Date): string {
  return formatInTimeZone(at, DEFAULT_TIMEZONE, "EEE, MMM d")
}

const things = (n: number) => `${n} ${n === 1 ? "thing needs" : "things need"} attention`

/** One line of the room's copy: text on one line (a title can't break the list), then the console path the room links */
const linked = (text: string, href: string) => `${text.replace(/\s+/g, " ").trim()} → ${href}`

/**
 * The room's copy: a lead line (who set it up, how many things), then each check that found something,
 * most urgent first, with its first items, and the checks that couldn't run. With `askSummary`, a last
 * line asks Jack for his summary (the note is then a scheduled one he answers)
 */
export function roomDigestText(report: DigestReport, { setUpBy, askSummary }: { setUpBy: string; askSummary: boolean }): string {
  const found = needingAttention(report)
  const failed = failedChecks(report)
  const total = attentionCount(report)
  const lead = linked(`Weekly digest for ${digestDay(report.at)} (set up by ${setUpBy}): ${total ? things(total) : "nothing needs attention"}`, "/admin")
  const lines: string[] = [lead]
  for (const { severity, heading } of SECTIONS) {
    const checks = found.filter((outcome) => outcome.result.severity === severity)
    if (!checks.length) continue
    lines.push("", heading)
    for (const { check, result } of checks) {
      lines.push(linked(`- ${check.label}: ${result.count}`, check.href))
      for (const item of result.items.slice(0, ROOM_ITEMS_PER_CHECK)) lines.push(`  ${linked(`- ${item.title}${item.detail ? ` (${item.detail})` : ""}`, item.href)}`)
      // Only the items cut here: a check's count can be in other units than its items (addresses, by email)
      const more = result.items.length - ROOM_ITEMS_PER_CHECK
      if (more > 0) lines.push(`  - and ${more} more`)
    }
  }
  if (failed.length) lines.push("", `Couldn't check: ${failed.map((outcome) => outcome.check.label).join(", ")}`)
  if (askSummary && total) lines.push("", "Jack: sum this up for the officers in a few sentences, most urgent first, using only what's listed here.")
  return lines.join("\n")
}

/** A console path as a full link to the site */
export function consoleUrl(siteUrl: string, href: string): string {
  return `${siteUrl.replace(/\/+$/, "")}${href.startsWith("/") ? href : `/${href}`}`
}

/** Text that can't ping or format anyone: no @, no mention syntax, no markdown links */
function plainForDiscord(text: string): string {
  return text.replace(/[@<>[\]`*_~|\\]/g, "").replace(/\s+/g, " ").trim()
}

/**
 * Discord's copy: a heading, then one line per check with its count and a console link (in <> so
 * Discord doesn't unfurl it). Labels only, never items. Cut to fit Discord's limit
 */
export function discordDigestText(report: DigestReport, siteUrl: string): string {
  const found = needingAttention(report)
  const failed = failedChecks(report).length
  const total = attentionCount(report)
  const head = `**LSR weekly digest** · ${digestDay(report.at)}\n${total ? `${things(total)} in the officer console:` : "Nothing needs attention in the officer console this week."}`
  const tail = failed ? `\n(${failed} ${failed === 1 ? "check" : "checks"} couldn't run; the console has the details.)` : ""
  const lines = found.map(({ check, result }) => `• ${plainForDiscord(check.label)}: ${result.count} <${consoleUrl(siteUrl, check.href)}>`)
  let body = ""
  for (const [i, line] of lines.entries()) {
    const rest = lines.length - i
    const more = `\n…and ${rest} more <${consoleUrl(siteUrl, "/admin")}>`
    if (head.length + body.length + line.length + 1 + tail.length + more.length > DISCORD_MAX_CHARS) {
      body += more
      break
    }
    body += `\n${line}`
  }
  return `${head}${body}${tail}`
}

/** Discord's create-message body: the text, with every ping turned off */
export function discordDigestMessage(report: DigestReport, siteUrl: string) {
  return { content: discordDigestText(report, siteUrl), allowed_mentions: { parse: [] as string[] }, flags: 4 /* SUPPRESS_EMBEDS */ }
}

/**
 * Teams' copy, as the Workflows webhook takes it: a message with one Adaptive Card (1.2) holding a title,
 * one line per check with its count and a console link, and a button to the console. Labels only
 */
export function teamsDigestCard(report: DigestReport, siteUrl: string) {
  const found = needingAttention(report)
  const failed = failedChecks(report).length
  const total = attentionCount(report)
  const text = (value: string, extra: Record<string, unknown> = {}) => ({ type: "TextBlock", text: value, wrap: true, ...extra })
  const escape = (value: string) => value.replace(/[[\]()*_`<>]/g, "")
  const body = [
    text(`LSR weekly digest · ${digestDay(report.at)}`, { weight: "Bolder", size: "Medium" }),
    text(total ? `${things(total)} in the officer console.` : "Nothing needs attention in the officer console this week.", { spacing: "Small" }),
    ...found.map(({ check, result }) => text(`- [${escape(check.label)}](${consoleUrl(siteUrl, check.href)}): ${result.count}`, { spacing: "Small" })),
    ...(failed ? [text(`${failed} ${failed === 1 ? "check" : "checks"} couldn't run; the console has the details.`, { isSubtle: true, spacing: "Small" })] : []),
  ]
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.2",
          body,
          actions: [{ type: "Action.OpenUrl", title: "Open the console", url: consoleUrl(siteUrl, "/admin") }],
        },
      },
    ],
  }
}
