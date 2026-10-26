import { afterEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_FAKES_URL, fakesEnabledFor, fakesOrigin, localOverride, serviceBaseUrl, serviceFetch } from "./base-url"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("fakesEnabledFor", () => {
  it("is off unless JACK_FAKES names the service or says all", () => {
    expect(fakesEnabledFor("discord", {})).toBe(false)
    expect(fakesEnabledFor("discord", { JACK_FAKES: "" })).toBe(false)
    expect(fakesEnabledFor("discord", { JACK_FAKES: "all" })).toBe(true)
    expect(fakesEnabledFor("discord", { JACK_FAKES: " Twitch, DISCORD " })).toBe(true)
    expect(fakesEnabledFor("stripe", { JACK_FAKES: "twitch,discord" })).toBe(false)
    expect(fakesEnabledFor("discord", { JACK_FAKES: "discord-post" })).toBe(false)
  })

  it("is never on in Vercel production", () => {
    expect(fakesEnabledFor("discord", { JACK_FAKES: "all", VERCEL_ENV: "production" })).toBe(false)
    expect(fakesEnabledFor("discord", { JACK_FAKES: "all", VERCEL_ENV: "preview" })).toBe(true)
  })
})

describe("fakesOrigin", () => {
  it("defaults to the local fakes server", () => {
    expect(fakesOrigin({})).toBe(DEFAULT_FAKES_URL)
    expect(fakesOrigin({ JACK_FAKES_URL: " http://localhost:4000/ignored/path " })).toBe("http://localhost:4000")
    expect(fakesOrigin({ JACK_FAKES_URL: "http://[::1]:4000" })).toBe("http://[::1]:4000")
  })

  it("refuses anything but plain http on this machine, since clients still send their keys", () => {
    expect(() => fakesOrigin({ JACK_FAKES_URL: "http://fakes.example.com:3999" })).toThrow(/this machine/)
    expect(() => fakesOrigin({ JACK_FAKES_URL: "http://10.0.0.5:3999" })).toThrow(/this machine/)
    expect(() => fakesOrigin({ JACK_FAKES_URL: "https://127.0.0.1:3999" })).toThrow(/http:\/\//)
    expect(() => fakesOrigin({ JACK_FAKES_URL: "not a url" })).toThrow(/isn't a URL/)
  })
})

describe("localOverride", () => {
  const REAL = "https://graph.instagram.com"

  it("is the real URL when the override isn't set, and the override (path kept) on this machine", () => {
    expect(localOverride("INSTAGRAM_GRAPH_URL", REAL, {})).toBe(REAL)
    expect(localOverride("INSTAGRAM_GRAPH_URL", REAL, { INSTAGRAM_GRAPH_URL: "  " })).toBe(REAL)
    expect(localOverride("INSTAGRAM_GRAPH_URL", REAL, { INSTAGRAM_GRAPH_URL: " http://127.0.0.1:4555/instagram/ " })).toBe("http://127.0.0.1:4555/instagram/")
    expect(localOverride("INSTAGRAM_GRAPH_URL", REAL, { INSTAGRAM_GRAPH_URL: "http://localhost:4555" })).toBe("http://localhost:4555")
    expect(localOverride("INSTAGRAM_GRAPH_URL", REAL, { INSTAGRAM_GRAPH_URL: "http://[::1]:4555", VERCEL_ENV: "preview" })).toBe("http://[::1]:4555")
  })

  it("is ignored on Vercel production, whatever it says, so a leftover value never gets the tokens", () => {
    for (const value of ["http://127.0.0.1:4555", "https://graph.example.com", "http://10.0.0.5", "not a url"]) {
      expect(localOverride("INSTAGRAM_GRAPH_URL", REAL, { INSTAGRAM_GRAPH_URL: value, VERCEL_ENV: "production" })).toBe(REAL)
    }
  })

  it("refuses anything but plain http on this machine elsewhere, like JACK_FAKES_URL, since the client sends its token there", () => {
    expect(() => localOverride("INSTAGRAM_GRAPH_URL", REAL, { INSTAGRAM_GRAPH_URL: "https://graph.example.com" })).toThrow("INSTAGRAM_GRAPH_URL must be http:// on this machine (127.0.0.1, localhost or [::1])")
    expect(() => localOverride("INSTAGRAM_GRAPH_URL", REAL, { INSTAGRAM_GRAPH_URL: "https://127.0.0.1:4555" })).toThrow(/must be http:\/\//)
    expect(() => localOverride("INSTAGRAM_GRAPH_URL", REAL, { INSTAGRAM_GRAPH_URL: "http://graph.instagram.com.example.net" })).toThrow(/this machine/)
    expect(() => localOverride("INSTAGRAM_GRAPH_URL", REAL, { INSTAGRAM_GRAPH_URL: "http://127.0.0.1@evil.example" })).toThrow(/this machine/)
    expect(() => localOverride("INSTAGRAM_GRAPH_URL", REAL, { INSTAGRAM_GRAPH_URL: "http://10.0.0.5:4555", VERCEL_ENV: "preview" })).toThrow(/this machine/)
    expect(() => localOverride("INSTAGRAM_GRAPH_URL", REAL, { INSTAGRAM_GRAPH_URL: "127.0.0.1:4555/x" })).toThrow(/this machine|isn't a URL/)
    expect(() => localOverride("INSTAGRAM_GRAPH_URL", REAL, { INSTAGRAM_GRAPH_URL: "not a url" })).toThrow("INSTAGRAM_GRAPH_URL isn't a URL")
  })
})

describe("serviceBaseUrl", () => {
  it("returns the real URL when fakes are off", () => {
    expect(serviceBaseUrl("discord", "https://discord.com/api/v10", {})).toBe("https://discord.com/api/v10")
    expect(serviceBaseUrl("discord", "https://discord.com/api/v10", { JACK_FAKES: "twitch" })).toBe("https://discord.com/api/v10")
  })

  it("keeps the real API's path under the service's mount on the fakes server", () => {
    const env = { JACK_FAKES: "all" }
    expect(serviceBaseUrl("discord", "https://discord.com/api/v10", env)).toBe("http://127.0.0.1:3999/discord/api/v10")
    expect(serviceBaseUrl("resend", "https://api.resend.com", env)).toBe("http://127.0.0.1:3999/resend")
    expect(serviceBaseUrl("resend", "https://api.resend.com/", env)).toBe("http://127.0.0.1:3999/resend/")
    expect(serviceBaseUrl("twitch", "https://id.twitch.tv/oauth2/", env)).toBe("http://127.0.0.1:3999/twitch/oauth2/")
    expect(serviceBaseUrl("google-drive", "https://www.googleapis.com", { JACK_FAKES: "google-drive", JACK_FAKES_URL: "http://localhost:4100" })).toBe(
      "http://localhost:4100/google-drive",
    )
  })

  it("lets JACK_FAKES win over a client's own override", () => {
    const env = { INSTAGRAM_GRAPH_URL: "http://127.0.0.1:4555" }
    expect(serviceBaseUrl("instagram", localOverride("INSTAGRAM_GRAPH_URL", "https://graph.instagram.com", env), env)).toBe("http://127.0.0.1:4555")
    expect(serviceBaseUrl("instagram", localOverride("INSTAGRAM_GRAPH_URL", "https://graph.instagram.com", env), { ...env, JACK_FAKES: "all" })).toBe("http://127.0.0.1:3999/instagram")
  })

  it("stays real in production, and fails loudly on a fakes URL off this machine", () => {
    expect(serviceBaseUrl("stripe", "https://api.stripe.com", { JACK_FAKES: "all", VERCEL_ENV: "production", JACK_FAKES_URL: "http://evil.example" })).toBe("https://api.stripe.com")
    expect(() => serviceBaseUrl("stripe", "https://api.stripe.com", { JACK_FAKES: "all", JACK_FAKES_URL: "http://evil.example" })).toThrow(/this machine/)
  })

  it("takes only service names that work as a path", () => {
    expect(() => serviceBaseUrl("Discord", "https://discord.com", {})).toThrow(/service name/)
    expect(() => serviceBaseUrl("../admin", "https://discord.com", {})).toThrow(/service name/)
  })
})

describe("serviceFetch", () => {
  /** Stubs the global fetch and returns where each call went */
  function stubFetch() {
    const calls: { url: string; method: string; body: string | null }[] = []
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      calls.push({ url: request.url, method: request.method, body: request.body ? await request.text() : null })
      return new Response("{}")
    })
    return calls
  }

  it("moves requests to the fakes server under the service's mount", async () => {
    const calls = stubFetch()
    const stripeFetch = serviceFetch("stripe", { JACK_FAKES: "stripe" })
    await stripeFetch("http://127.0.0.1:3999/v1/balance?expand[]=x")
    await stripeFetch(new URL("http://127.0.0.1:3999/v1/charges"), { method: "POST", body: "amount=500" })
    await stripeFetch(new Request("http://127.0.0.1:3999/v1/refunds", { method: "POST", body: "charge=ch_1" }))
    expect(calls).toEqual([
      { url: "http://127.0.0.1:3999/stripe/v1/balance?expand[]=x", method: "GET", body: null },
      { url: "http://127.0.0.1:3999/stripe/v1/charges", method: "POST", body: "amount=500" },
      { url: "http://127.0.0.1:3999/stripe/v1/refunds", method: "POST", body: "charge=ch_1" },
    ])
  })

  it("leaves every request alone when fakes are off, and requests to other origins when they're on", async () => {
    const calls = stubFetch()
    await serviceFetch("stripe", {})("https://api.stripe.com/v1/balance")
    await serviceFetch("stripe", { JACK_FAKES: "all", VERCEL_ENV: "production" })("https://api.stripe.com/v1/balance")
    await serviceFetch("stripe", { JACK_FAKES: "all" })("http://127.0.0.1:4000/v1/balance")
    expect(calls.map((call) => call.url)).toEqual(["https://api.stripe.com/v1/balance", "https://api.stripe.com/v1/balance", "http://127.0.0.1:4000/v1/balance"])
  })

  it("checks the service name and the fakes URL when it's made", () => {
    expect(() => serviceFetch("../admin", {})).toThrow(/service name/)
    expect(() => serviceFetch("stripe", { JACK_FAKES: "all", JACK_FAKES_URL: "http://evil.example" })).toThrow(/this machine/)
  })
})
