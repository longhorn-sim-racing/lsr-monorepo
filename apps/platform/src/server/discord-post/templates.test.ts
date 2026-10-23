import { describe, expect, it } from "vitest"
import { messageProblems } from "@/server/connectors/discord/write"
import { eventProblem, forPost, type EventRow } from "./events"
import { discordTime, eventReminderBody, newEventBody, offsetLabel, pingParts, resultsBody, standingsBody, twitchLiveBody, type EventForPost } from "./templates"

const SITE = "https://www.longhornsimracing.org"
const NOW = new Date("2026-10-23T17:00:00Z")
const START = new Date("2026-10-26T23:00:00Z")

const event: EventForPost = {
  slug: "gm-2",
  title: "GM 2 **Recruiting** @everyone",
  summary: "Meet the teams. Bring a friend! https://evil.example/claim",
  startsAtUtc: START,
  endsAtUtc: new Date("2026-10-27T01:00:00Z"),
  venue: { name: "Alienware Lounge", room: "GDC 1.402" },
  registrationEnabled: true,
  registrationClosesAt: new Date("2026-10-26T18:00:00Z"),
}

describe("pings", () => {
  it("ping nobody unless a rule or post names one, and then exactly that one", () => {
    expect(pingParts(null)).toEqual({ prefix: "", allowed: { parse: [] } })
    expect(pingParts({ type: "role", roleId: "223456789012345678", name: "LSC Driver" })).toEqual({ prefix: "<@&223456789012345678> ", allowed: { parse: [], roles: ["223456789012345678"] } })
    expect(pingParts({ type: "everyone" })).toEqual({ prefix: "@everyone ", allowed: { parse: ["everyone"] } })
    expect(pingParts({ type: "here" }).prefix).toBe("@here ")
  })
})

describe("event templates", () => {
  it("remind with the event's public facts, its page, Discord times and no ping", () => {
    const body = eventReminderBody(event, { siteUrl: SITE, now: NOW })
    expect(body.allowed_mentions).toEqual({ parse: [] })
    expect(body.content).toBe(`Reminder: **GM 2 \\*\\*Recruiting\\*\\* everyone** starts ${discordTime(START, "R")}.`)
    const embed = body.embeds![0]
    expect(embed.url).toBe(`${SITE}/events/gm-2`)
    expect(embed.description).toBe("Meet the teams. Bring a friend!")
    expect(embed.fields).toEqual([
      { name: "When", value: `<t:${START.getTime() / 1000}:F> (<t:${START.getTime() / 1000}:R>)`, inline: false },
      { name: "Where", value: "Alienware Lounge, GDC 1.402", inline: false },
      { name: "Registration", value: `Open on the event page, until <t:${Date.parse("2026-10-26T18:00:00Z") / 1000}:f>`, inline: false },
    ])
    expect(messageProblems(body)).toEqual([])
  })

  it("leave out registration once it's closed, and the venue when there's none", () => {
    const body = newEventBody({ ...event, venue: null, registrationClosesAt: new Date("2026-10-20T00:00:00Z") }, { siteUrl: SITE, now: NOW, ping: { type: "role", roleId: "223456789012345678", name: "LSC Driver" } })
    expect(body.content).toMatch(/^<@&223456789012345678> New event: \*\*GM 2/)
    expect(body.embeds![0].fields!.map((f) => f.name)).toEqual(["When"])
    expect(body.allowed_mentions).toEqual({ parse: [], roles: ["223456789012345678"] })
  })

  it("never carry the meeting link: the event a rule reads has none", () => {
    const row = { ...event, id: "e1", status: "PUBLISHED", visibility: "public", publishedAt: NOW, updatedAt: NOW, series: null, venue: event.venue, meetingUrl: "https://zoom.example/j/123" } as unknown as EventRow
    const body = eventReminderBody(forPost(row), { siteUrl: SITE, now: NOW })
    expect(JSON.stringify(body)).not.toContain("zoom.example")
    expect(Object.keys(forPost(row))).not.toContain("meetingUrl")
  })
})

describe("which events rules post about", () => {
  const at = (over: Partial<EventRow>) => ({ status: "PUBLISHED", visibility: "public", publishedAt: NOW, series: null, ...over }) as Pick<EventRow, "status" | "visibility" | "publishedAt" | "series">

  it("public ones only (isEventPublic), never cancelled or postponed, and in the rule's series", () => {
    expect(eventProblem(at({}), NOW)).toBeNull()
    expect(eventProblem(at({ status: "DRAFT" }), NOW)).toBe("isn't public on the site")
    expect(eventProblem(at({ visibility: "members" }), NOW)).toBe("isn't public on the site")
    expect(eventProblem(at({ visibility: "officers" }), NOW)).toBe("isn't public on the site")
    // Scheduled to publish later: not yet; once its time passed: public
    expect(eventProblem(at({ status: "SCHEDULED", publishedAt: new Date("2026-10-24T00:00:00Z") }), NOW)).toBe("isn't public on the site")
    expect(eventProblem(at({ status: "SCHEDULED", publishedAt: new Date("2026-10-22T00:00:00Z") }), NOW)).toBeNull()
    expect(eventProblem(at({ status: "CANCELLED" }), NOW)).toBe("was cancelled")
    expect(eventProblem(at({ status: "POSTPONED" }), NOW)).toBe("was postponed")
    expect(eventProblem(at({ series: { slug: "lsc" } }), NOW, "gm")).toBe("isn't in the rule's series")
    expect(eventProblem(at({ series: { slug: "lsc" } }), NOW, "lsc")).toBeNull()
  })
})

describe("results, standings and Twitch templates", () => {
  it("post a race's podium with a link to the results", () => {
    const body = resultsBody({ event: { slug: "lsc-r3", title: "LSC Round 3" }, trackName: "Monza", podium: ["Avery Reyes", "Blake **Okafor**", "@everyone Casey"] }, { siteUrl: SITE })
    expect(body.content).toBe(["Results are up for **LSC Round 3** at Monza.", "", "1. Avery Reyes", "2. Blake \\*\\*Okafor\\*\\*", "3. everyone Casey", "", `Full results: ${SITE}/events/lsc-r3#results`].join("\n"))
    expect(body.allowed_mentions).toEqual({ parse: [] })
  })

  it("post the top of the standings", () => {
    const body = standingsBody({ seasonName: "LSC Season 3", rows: [{ name: "Avery", points: 75 }, { name: "Blake", points: 1 }], url: `${SITE}/lone-star-cup` }, {})
    expect(body.content).toBe(["**LSC Season 3** standings are updated.", "", "1. Avery, 75 pts", "2. Blake, 1 pt", "", `Full standings: ${SITE}/lone-star-cup`].join("\n"))
  })

  it("treat a stream's title as outside text: no mentions, links or Markdown", () => {
    const body = twitchLiveBody({ title: "@everyone [FREE NITRO](https://scam.example) **LSC** <@&1>", gameName: "Assetto Corsa", channelUrl: "https://www.twitch.tv/longhorn_sim_racing" }, {})
    expect(body.content).toBe(["Longhorn Sim Racing is live on Twitch (Assetto Corsa).", "> everyone FREE NITRO \\*\\*LSC\\*\\*", "https://www.twitch.tv/longhorn_sim_racing"].join("\n"))
    expect(body.content).not.toContain("scam.example")
    expect(body.allowed_mentions).toEqual({ parse: [] })
    // An empty title (Twitch fills it in a few seconds after going live) leaves the quote out
    expect(twitchLiveBody({ title: "", gameName: null, channelUrl: "https://www.twitch.tv/x" }, {}).content).toBe("Longhorn Sim Racing is live on Twitch.\nhttps://www.twitch.tv/x")
  })

  it("name reminder offsets in words", () => {
    expect([1440, 60, 30, 90, 10_080].map(offsetLabel)).toEqual(["1 day", "1 hour", "30 minutes", "1 hour 30 minutes", "7 days"])
  })
})
