import { describe, expect, it } from "vitest"
import { DEFAULT_FAKES_URL, fakesEnabledFor, fakesOrigin, serviceBaseUrl } from "./base-url"

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
    const override = "http://127.0.0.1:4555"
    expect(serviceBaseUrl("instagram", override, {})).toBe(override)
    expect(serviceBaseUrl("instagram", override, { JACK_FAKES: "all" })).toBe("http://127.0.0.1:3999/instagram")
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
