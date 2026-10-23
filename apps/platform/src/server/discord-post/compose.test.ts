import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fakeRoles } from "@/server/connectors/discord/fake/data"
import { officerAskedPing, postBody, resolvePing, sendTime } from "./compose"

const roles = fakeRoles()
const lscDriver = roles.find((r) => r.name === "LSC Driver")!

describe("pings", () => {
  it("resolve a role by name or id when it's pingable, and @everyone only when the bot may", () => {
    expect(resolvePing(undefined, { roles, mentionEveryone: false })).toEqual({ ok: true, ping: null })
    expect(resolvePing("@lsc driver", { roles, mentionEveryone: false })).toEqual({ ok: true, ping: { type: "role", roleId: lscDriver.id, name: "LSC Driver" } })
    expect(resolvePing(lscDriver.id, { roles, mentionEveryone: false })).toMatchObject({ ok: true })
    expect(resolvePing("Member", { roles, mentionEveryone: false })).toMatchObject({ ok: false, error: expect.stringMatching(/can't be pinged by the bot/) })
    expect(resolvePing("Member", { roles, mentionEveryone: true })).toMatchObject({ ok: true })
    expect(resolvePing("everyone", { roles, mentionEveryone: false })).toMatchObject({ ok: false, error: expect.stringMatching(/Mention @everyone/) })
    expect(resolvePing("@here", { roles, mentionEveryone: true })).toEqual({ ok: true, ping: { type: "here" } })
    expect(resolvePing("@everyone role", { roles, mentionEveryone: true })).toMatchObject({ ok: false, error: expect.stringMatching(/no role called/) })
  })

  it("need an officer's ask in the room: the mention itself, or 'ping', 'tag', 'mention' or 'notify' with the name", () => {
    const role = { type: "role" as const, roleId: lscDriver.id, name: "LSC Driver" }
    expect(officerAskedPing(role, ["Post the GM reminder"])).toBe(false)
    expect(officerAskedPing(role, ["the LSC Driver role is new"])).toBe(false)
    expect(officerAskedPing(role, ["post it and ping the LSC drivers"])).toBe(true)
    expect(officerAskedPing(role, ["tag @LSC Driver please"])).toBe(true)
    expect(officerAskedPing(role, [`<@&${lscDriver.id}> should see this`])).toBe(true)
    expect(officerAskedPing({ type: "everyone" }, ["tell everyone about GM"])).toBe(false)
    expect(officerAskedPing({ type: "everyone" }, ["ping everyone about GM"])).toBe(true)
    expect(officerAskedPing({ type: "everyone" }, ["post with @everyone"])).toBe(true)
    expect(officerAskedPing({ type: "here" }, ["post it here"])).toBe(false)
    expect(officerAskedPing({ type: "here" }, ["notify here"])).toBe(true)
  })

  it("put the mention first and let exactly it through", () => {
    expect(postBody({ text: "GM tonight", ping: { type: "role", roleId: lscDriver.id, name: "LSC Driver" } })).toEqual({ content: `<@&${lscDriver.id}> GM tonight`, allowed_mentions: { parse: [], roles: [lscDriver.id] } })
    expect(postBody({ poll: { question: "Night?", answers: ["Mon", "Wed"] } })).toEqual({
      poll: { question: { text: "Night?" }, answers: [{ poll_media: { text: "Mon" } }, { poll_media: { text: "Wed" } }], duration: 24, allow_multiselect: false, layout_type: 1 },
      allowed_mentions: { parse: [] },
    })
  })
})

describe("send times", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-23T17:00:00Z"))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("are Central, in the future, at most 30 days ahead", () => {
    expect(sendTime(undefined)).toEqual({ ok: true, at: null })
    expect(sendTime("2026-10-26T18:00")).toEqual({ ok: true, at: new Date("2026-10-26T23:00:00Z") })
    expect(sendTime("2026-11-15T18:00")).toEqual({ ok: true, at: new Date("2026-11-16T00:00:00Z") })
    expect(sendTime("2026-10-23T11:00")).toMatchObject({ ok: false, error: expect.stringMatching(/has passed/) })
    expect(sendTime("2027-01-01T10:00")).toMatchObject({ ok: false, error: expect.stringMatching(/30 days/) })
    expect(sendTime("2026-02-30T10:00")).toMatchObject({ ok: false, error: expect.stringMatching(/isn't a time on the calendar/) })
    expect(sendTime("tomorrow")).toMatchObject({ ok: false })
  })
})
