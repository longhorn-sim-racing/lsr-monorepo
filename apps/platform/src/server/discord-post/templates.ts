import { clipText, templateValue } from "@/lib/discord/text"
import type { DiscordAllowedMentions, DiscordEmbed, DiscordMessageBody } from "@/server/connectors/discord/write"

/**
 * The standing rules' messages (design §12.1: "templates only"). Every word is fixed here; the only values
 * are our own data (an event's title, time, venue and page; a race's track and podium; the standings) and,
 * for twitch_live, the stream's title. Each value goes through templateValue(): one line, mentions and
 * links taken out, Markdown escaped. Links are the club site's own pages. An event's meeting link
 * (meetingUrl) is never read here. A post pings nobody unless its rule names a role to ping.
 */

/** LSR orange (#FF8000), the embeds' accent */
export const LSR_ORANGE = 0xff8000

const FOOTER = { text: "Longhorn Sim Racing" }

/** A role a rule (or a post) pings, with its name as it was when the rule was saved, for the card and the page */
export type PingTarget = { type: "role"; roleId: string; name: string } | { type: "everyone" } | { type: "here" }

/** The ping's mention at the start of the text, and the allowed_mentions that lets exactly it through (nobody otherwise) */
export function pingParts(ping: PingTarget | null | undefined): { prefix: string; allowed: DiscordAllowedMentions } {
  if (!ping) return { prefix: "", allowed: { parse: [] } }
  if (ping.type === "role") return { prefix: `<@&${ping.roleId}> `, allowed: { parse: [], roles: [ping.roleId] } }
  // @everyone and @here are both allowed by "everyone" (research §3 W1)
  return { prefix: ping.type === "everyone" ? "@everyone " : "@here ", allowed: { parse: ["everyone"] } }
}

/** "@LSC Driver", "@everyone", "@here" */
export function pingLabel(ping: PingTarget | null | undefined): string | null {
  if (!ping) return null
  return ping.type === "role" ? `@${ping.name}` : ping.type === "everyone" ? "@everyone" : "@here"
}

/** Discord's timestamp markup: shown in each reader's own time zone ("F" full date and time, "R" relative) */
export const discordTime = (at: Date, style: "F" | "R" | "f" | "t" = "F") => `<t:${Math.floor(at.getTime() / 1000)}:${style}>`

/** An event as the templates read it: what's public about it, never its meeting link */
export type EventForPost = {
  slug: string
  title: string
  summary: string | null
  startsAtUtc: Date
  endsAtUtc: Date
  venue: { name: string; room: string | null } | null
  registrationEnabled: boolean
  registrationClosesAt: Date | null
}

export const eventUrl = (siteUrl: string, slug: string) => `${siteUrl}/events/${encodeURIComponent(slug)}`

/** "Monza, Room 1.102"; null with no venue */
function where(event: EventForPost): string | null {
  if (!event.venue) return null
  return templateValue([event.venue.name, event.venue.room].filter(Boolean).join(", "), 200) || null
}

function eventEmbed(event: EventForPost, siteUrl: string, now: Date): DiscordEmbed {
  const fields: DiscordEmbed["fields"] = [{ name: "When", value: `${discordTime(event.startsAtUtc, "F")} (${discordTime(event.startsAtUtc, "R")})`, inline: false }]
  const place = where(event)
  if (place) fields.push({ name: "Where", value: place, inline: false })
  if (event.registrationEnabled && (!event.registrationClosesAt || event.registrationClosesAt > now)) {
    fields.push({ name: "Registration", value: `Open on the event page${event.registrationClosesAt ? `, until ${discordTime(event.registrationClosesAt, "f")}` : ""}`, inline: false })
  }
  const summary = templateValue(event.summary, 300)
  return {
    title: clipText(templateValue(event.title, 250), 256),
    url: eventUrl(siteUrl, event.slug),
    ...(summary ? { description: summary } : {}),
    color: LSR_ORANGE,
    fields,
    footer: FOOTER,
  }
}

/** "1 day", "2 hours", "30 minutes", "1 hour 30 minutes" */
export function offsetLabel(minutes: number): string {
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`
  if (minutes % 1440 === 0) return unit(minutes / 1440, "day")
  if (minutes >= 60) return minutes % 60 ? `${unit(Math.floor(minutes / 60), "hour")} ${unit(minutes % 60, "minute")}` : unit(minutes / 60, "hour")
  return unit(minutes, "minute")
}

type TemplateOptions = { siteUrl: string; ping?: PingTarget | null; now?: Date }

/** event_reminder: "Reminder: GM 2 starts in 1 hour." with the event's card */
export function eventReminderBody(event: EventForPost, { siteUrl, ping, now = new Date() }: TemplateOptions): DiscordMessageBody {
  const { prefix, allowed } = pingParts(ping)
  return {
    content: `${prefix}Reminder: **${templateValue(event.title, 200)}** starts ${discordTime(event.startsAtUtc, "R")}.`,
    embeds: [eventEmbed(event, siteUrl, now)],
    allowed_mentions: allowed,
  }
}

/** new_event: "New event: GM 2" with the event's card */
export function newEventBody(event: EventForPost, { siteUrl, ping, now = new Date() }: TemplateOptions): DiscordMessageBody {
  const { prefix, allowed } = pingParts(ping)
  return {
    content: `${prefix}New event: **${templateValue(event.title, 200)}**`,
    embeds: [eventEmbed(event, siteUrl, now)],
    allowed_mentions: allowed,
  }
}

/** results_posted: the race's top three and a link to the full results */
export function resultsBody(input: { event: Pick<EventForPost, "slug" | "title">; trackName: string | null; podium: string[] }, { siteUrl, ping }: TemplateOptions): DiscordMessageBody {
  const { prefix, allowed } = pingParts(ping)
  const track = templateValue(input.trackName, 80)
  const lines = [`${prefix}Results are up for **${templateValue(input.event.title, 200)}**${track ? ` at ${track}` : ""}.`]
  if (input.podium.length) lines.push("", ...input.podium.slice(0, 3).map((name, i) => `${i + 1}. ${templateValue(name, 60)}`))
  lines.push("", `Full results: ${eventUrl(siteUrl, input.event.slug)}#results`)
  return { content: lines.join("\n"), allowed_mentions: allowed }
}

/** standings_update: the top of the standings and a link to the full table */
export function standingsBody(input: { seasonName: string; rows: { name: string; points: number }[]; url: string }, { ping }: Omit<TemplateOptions, "siteUrl">): DiscordMessageBody {
  const { prefix, allowed } = pingParts(ping)
  const lines = [`${prefix}**${templateValue(input.seasonName, 120)}** standings are updated.`, ""]
  input.rows.forEach((row, i) => lines.push(`${i + 1}. ${templateValue(row.name, 60)}, ${row.points} ${row.points === 1 ? "pt" : "pts"}`))
  lines.push("", `Full standings: ${input.url}`)
  return { content: lines.join("\n"), allowed_mentions: allowed }
}

/** twitch_live: the stream's title (outside text: one line, no mentions or links, no Markdown) and the channel */
export function twitchLiveBody(input: { title: string; gameName: string | null; channelUrl: string }, { ping }: Omit<TemplateOptions, "siteUrl">): DiscordMessageBody {
  const { prefix, allowed } = pingParts(ping)
  const title = templateValue(input.title, 140)
  const game = templateValue(input.gameName, 60)
  const lines = [`${prefix}Longhorn Sim Racing is live on Twitch${game ? ` (${game})` : ""}.`]
  if (title) lines.push(`> ${title}`)
  lines.push(input.channelUrl)
  return { content: lines.join("\n"), allowed_mentions: allowed }
}
