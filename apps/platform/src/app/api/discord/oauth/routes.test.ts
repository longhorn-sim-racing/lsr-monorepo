import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const session = vi.hoisted(() => ({ getSessionUser: vi.fn() }))
const service = vi.hoisted(() => ({
  startDiscordLink: vi.fn(),
  finishDiscordLink: vi.fn(),
  LINK_COOKIE: "lsr_discord_link",
  LINK_COOKIE_PATH: "/api/discord/oauth",
  LINK_COOKIE_MAX_AGE_S: 600,
}))
vi.mock("@/server/auth/session", () => session)
vi.mock("@/server/services/discord-link.service", () => service)

import { GET } from "./callback/route"
import { POST } from "./start/route"

const member = { id: "user-1", handle: "avery-lane", discordUserId: null }

beforeEach(() => {
  session.getSessionUser.mockResolvedValue({ user: member, roles: [] })
})

describe("POST /api/discord/oauth/start", () => {
  const start = () => POST(new NextRequest("https://lsr.test/api/discord/oauth/start", { method: "POST" }))

  it("sends a signed-in member to Discord with the sealed cookie, only for the OAuth routes", async () => {
    service.startDiscordLink.mockResolvedValue({ ok: true, url: "https://discord.com/oauth2/authorize?client_id=1", cookie: "sealed" })
    const res = await start()
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("https://discord.com/oauth2/authorize?client_id=1")
    const cookie = res.headers.get("set-cookie")!
    expect(cookie).toMatch(/^lsr_discord_link=sealed/)
    expect(cookie).toMatch(/Path=\/api\/discord\/oauth/)
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=lax/i)
    expect(cookie).toMatch(/Secure/i)
    expect(cookie).toMatch(/Max-Age=600/)
    expect(service.startDiscordLink).toHaveBeenCalledWith(member)
  })

  it("sends someone signed out to sign in, and a member who can't link back to their profile with why", async () => {
    session.getSessionUser.mockResolvedValue({ user: null, roles: [] })
    expect((await start()).headers.get("location")).toBe("https://lsr.test/auth/signin?next=/account")

    session.getSessionUser.mockResolvedValue({ user: member, roles: [] })
    service.startDiscordLink.mockResolvedValue({ ok: false, outcome: "already" })
    const res = await start()
    expect(res.headers.get("location")).toBe("https://lsr.test/drivers/avery-lane/edit?discord=already#discord")
    expect(res.headers.get("set-cookie")).toBeNull()
  })
})

describe("GET /api/discord/oauth/callback", () => {
  const callback = (query: string, cookie = "sealed") =>
    GET(new NextRequest(`https://lsr.test/api/discord/oauth/callback?${query}`, { headers: { cookie: `lsr_discord_link=${cookie}` } }))

  it("finishes for the signed-in member, clears the cookie and lands on their profile with the outcome", async () => {
    service.finishDiscordLink.mockResolvedValue("linked")
    const res = await callback("code=abc&state=xyz&iss=https%3A%2F%2Fdiscord.com")
    expect(service.finishDiscordLink).toHaveBeenCalledWith({ userId: "user-1", cookie: "sealed", code: "abc", state: "xyz", iss: "https://discord.com", error: null })
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("https://lsr.test/drivers/avery-lane/edit?discord=linked#discord")
    expect(res.headers.get("set-cookie")).toMatch(/lsr_discord_link=;.*Max-Age=0/)
    expect(res.headers.get("referrer-policy")).toBe("no-referrer")
    expect(res.headers.get("cache-control")).toBe("no-store")
  })

  it("passes Discord's error on, and links nothing for someone signed out", async () => {
    service.finishDiscordLink.mockResolvedValue("cancelled")
    await callback("error=access_denied&state=xyz")
    expect(service.finishDiscordLink).toHaveBeenCalledWith(expect.objectContaining({ error: "access_denied", code: null }))

    service.finishDiscordLink.mockClear()
    session.getSessionUser.mockResolvedValue({ user: null, roles: [] })
    const res = await callback("code=abc&state=xyz")
    expect(service.finishDiscordLink).not.toHaveBeenCalled()
    expect(res.headers.get("location")).toBe("https://lsr.test/auth/signin?next=/account")
  })
})
