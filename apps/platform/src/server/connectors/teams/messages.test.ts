import { describe, expect, it } from "vitest"
import { teamsText } from "./html"
import { channelIdsFromEnv, parseMessageResource, subscriptionResource, toTeamsMessage } from "./messages"

describe("teamsText", () => {
  it("turns Teams' HTML into text: paragraphs, mentions, links with their address, entities", () => {
    expect(teamsText('<p>I do. <at id="0">Fixture Officer A</at>, grab it from me.</p><p>Thanks&nbsp;&amp; see you</p>')).toBe("I do. @Fixture Officer A, grab it from me.\n\nThanks & see you")
    expect(teamsText('Bring the <a href="https://example.com/deck">pitch deck</a>.')).toBe("Bring the pitch deck (https://example.com/deck).")
    expect(teamsText('<a href="https://example.com/x">https://example.com/x</a>')).toBe("https://example.com/x")
    expect(teamsText('<a href="javascript:alert(1)">click</a>')).toBe("click")
  })

  it("keeps lists, line breaks, emoji and tables readable", () => {
    expect(teamsText("<ul><li>One</li><li>Two</li></ul>")).toBe("- One\n- Two")
    expect(teamsText("a<br>b<br/>c")).toBe("a\nb\nc")
    expect(teamsText('Nice <emoji id="1f3c1" alt="🏁" title="Flag"></emoji>')).toBe("Nice 🏁")
    expect(teamsText("<table><tr><td>Tires</td><td>120</td></tr></table>")).toBe("Tires | 120 |")
  })

  it("notes images and attachments, and leaves plain text alone", () => {
    expect(teamsText('See <img src="https://x/hostedContents/1/$value" alt="rig photo">')).toBe("See (image: rig photo)")
    expect(teamsText('<attachment id="abc"></attachment>Report')).toBe("(attachment)Report")
    expect(teamsText("5 < 6 and <b>bold</b>", "html")).toBe("5 < 6 and bold")
    expect(teamsText("Plain <b>text</b>", "text")).toBe("Plain <b>text</b>")
    expect(teamsText(null)).toBe("")
  })

  it("caps a very long message", () => {
    expect(teamsText(`<p>${"word ".repeat(10_000)}</p>`).length).toBeLessThanOrEqual(20_000)
  })

  it("drops NUL characters, which Postgres can't store", () => {
    expect(teamsText("<p>Budget\u0000 2026</p>")).toBe("Budget 2026")
    expect(teamsText("Plain\u0000 text", "text")).toBe("Plain text")
  })

  it("reads unclosed tags in linear time", () => {
    const started = Date.now()
    teamsText("<a ".repeat(100_000))
    teamsText(`<${"a".repeat(300_000)}`)
    // Quadratic matching took seconds on inputs this size
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe("toTeamsMessage", () => {
  const base = { id: "2", createdDateTime: "2026-10-14T16:00:00Z", from: { user: { id: "aad-b", displayName: "Fixture Officer B" } }, body: { contentType: "html", content: "<p>Hi</p>" } }

  it("maps a reply with its thread, author and edit time", () => {
    expect(toTeamsMessage({ ...base, replyToId: "1", lastEditedDateTime: "2026-10-14T17:00:00Z" }, "19:c@thread.tacv2")).toEqual({
      id: "2",
      channelId: "19:c@thread.tacv2",
      replyToId: "1",
      authorAadId: "aad-b",
      authorName: "Fixture Officer B",
      content: "Hi",
      createdAt: new Date("2026-10-14T16:00:00Z"),
      editedAt: new Date("2026-10-14T17:00:00Z"),
      deletedAt: null,
    })
  })

  it("names an app's messages after the app", () => {
    expect(toTeamsMessage({ ...base, from: { user: null, application: { displayName: "Fixture Reminders" } } }, "c")).toMatchObject({ authorName: "Fixture Reminders", authorAadId: null })
  })

  it("keeps no text of a deleted message", () => {
    expect(toTeamsMessage({ ...base, deletedDateTime: "2026-10-15T18:00:00Z" }, "c")).toMatchObject({ content: "", deletedAt: new Date("2026-10-15T18:00:00Z") })
    expect(toTeamsMessage({ ...base, "@removed": { reason: "deleted" } }, "c")).toMatchObject({ content: "", deletedAt: expect.any(Date) })
  })

  it("skips system events and kinds it doesn't know", () => {
    expect(toTeamsMessage({ ...base, messageType: "systemEventMessage" }, "c")).toBeNull()
    expect(toTeamsMessage({ ...base, messageType: "unknownFutureValue" }, "c")).toBeNull()
  })
})

describe("parseMessageResource", () => {
  it("reads Graph's resource strings, replies included", () => {
    expect(parseMessageResource("teams('t1')/channels('19:abc@thread.tacv2')/messages('111')")).toEqual({ teamId: "t1", channelId: "19:abc@thread.tacv2", messageId: "111" })
    expect(parseMessageResource("teams('t1')/channels('19:abc@thread.tacv2')/messages('111')/replies('222')")).toEqual({ teamId: "t1", channelId: "19:abc@thread.tacv2", messageId: "111", replyId: "222" })
    expect(parseMessageResource("/teams/t1/channels/19%3Aabc%40thread.tacv2/messages/111")).toEqual({ teamId: "t1", channelId: "19:abc@thread.tacv2", messageId: "111" })
  })

  it("refuses anything else", () => {
    expect(parseMessageResource("users('u')/messages('1')")).toBeNull()
    expect(parseMessageResource("teams('t')/channels('c')/messages('1')/extra")).toBeNull()
    expect(parseMessageResource(undefined)).toBeNull()
  })
})

describe("channel ids", () => {
  it("keeps only channel ids from MS_CHANNEL_IDS, once each", () => {
    expect(channelIdsFromEnv(" 19:a@thread.tacv2, general ,19:b@thread.skype,19:a@thread.tacv2,")).toEqual(["19:a@thread.tacv2", "19:b@thread.skype"])
    expect(channelIdsFromEnv(undefined)).toEqual([])
  })

  it("writes a subscription's resource with the ids as they are", () => {
    expect(subscriptionResource("t1", "19:a@thread.tacv2")).toBe("/teams/t1/channels/19:a@thread.tacv2/messages")
  })
})
