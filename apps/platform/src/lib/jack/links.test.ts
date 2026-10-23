import { describe, expect, it } from "vitest"
import { formatFileSize, linkHost, partLink } from "./links"

describe("linkHost", () => {
  it("reads the host from the URL, without www.", () => {
    expect(linkHost("https://www.longhornsimracing.org/events")).toBe("longhornsimracing.org")
    expect(linkHost("https://discord.com/channels/1/2")).toBe("discord.com")
    expect(linkHost("http://docs.google.com/document/d/x")).toBe("docs.google.com")
  })

  it("shows what the browser will really open, not what the text looks like", () => {
    expect(linkHost("https://stripe.com@evil.example/login")).toBe("evil.example")
    // A lookalike with an accented letter shows as xn--…, not as "stripe.com"
    expect(linkHost("https://strípe.com/")).toMatch(/^xn--[a-z0-9-]+\.com$/)
  })

  it("is null for site paths and anything that isn't a web link", () => {
    expect(linkHost("/admin/events")).toBeNull()
    expect(linkHost("mailto:officers@example.com")).toBeNull()
    expect(linkHost("javascript:alert(1)")).toBeNull()
    expect(linkHost("not a url")).toBeNull()
  })
})

describe("partLink", () => {
  it("keeps site paths in the app, with their query and hash", () => {
    expect(partLink("/admin/events/abc/manage")).toEqual({ href: "/admin/events/abc/manage", internal: true })
    expect(partLink("/admin/results?upload=1#top")).toEqual({ href: "/admin/results?upload=1#top", internal: true })
  })

  it("gives web links their host, in the form the browser will follow", () => {
    expect(partLink(" https://www.twitch.tv/longhornsimracing ")).toEqual({ href: "https://www.twitch.tv/longhornsimracing", internal: false, host: "twitch.tv" })
    expect(partLink("https://Discord.com")).toEqual({ href: "https://discord.com/", internal: false, host: "discord.com" })
  })

  it("refuses paths that browsers would turn into another site (tabs, line breaks, backslashes)", () => {
    for (const url of ["/\t/evil.example/x", "/\n/evil.example", "/\r/evil.example", "/\r\n/evil.example", "/\\evil.example", "/\\\\evil.example", "/a\\..\\..\\evil.example", "/\u0000/evil.example", "/\u007f/evil.example"]) {
      expect(partLink(url), JSON.stringify(url)).toBeNull()
    }
  })

  it("refuses a path that resolves to a protocol-relative one", () => {
    expect(partLink("/a/..//evil.example")).toBeNull()
    expect(partLink("/./..//evil.example/x")).toBeNull()
  })

  it("keeps encoded characters encoded, so they stay on this site", () => {
    expect(partLink("/%09/evil.example")).toEqual({ href: "/%09/evil.example", internal: true })
    expect(partLink("/%0A/evil.example")).toEqual({ href: "/%0A/evil.example", internal: true })
    expect(partLink("/%2F%2Fevil.example")).toEqual({ href: "/%2F%2Fevil.example", internal: true })
    expect(partLink("/%5Cevil.example")).toEqual({ href: "/%5Cevil.example", internal: true })
  })

  it("refuses control characters in web links too", () => {
    expect(partLink("https://evil.exa\tmple/")).toBeNull()
    expect(partLink("https://discord.com/\nx")).toBeNull()
  })

  it("refuses protocol-relative links, scripts, data and email", () => {
    expect(partLink("//evil.example/x")).toBeNull()
    expect(partLink("/\\evil.example")).toBeNull()
    expect(partLink("javascript:alert(1)")).toBeNull()
    expect(partLink("data:text/html,hi")).toBeNull()
    expect(partLink("mailto:someone@example.com")).toBeNull()
    expect(partLink("")).toBeNull()
  })
})

describe("formatFileSize", () => {
  it("reads like a person would say it", () => {
    expect(formatFileSize(820)).toBe("820 B")
    expect(formatFileSize(14_200)).toBe("14 KB")
    expect(formatFileSize(2_400_000)).toBe("2.4 MB")
    expect(formatFileSize(3_000_000)).toBe("3 MB")
    expect(formatFileSize(24_600_000)).toBe("25 MB")
    expect(formatFileSize(1_200_000_000)).toBe("1.2 GB")
  })

  it("is empty for a size that makes no sense", () => {
    expect(formatFileSize(-1)).toBe("")
    expect(formatFileSize(Number.NaN)).toBe("")
  })
})
