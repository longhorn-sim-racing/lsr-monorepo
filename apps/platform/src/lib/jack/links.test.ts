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
  it("keeps site paths in the app", () => {
    expect(partLink("/admin/events/abc/manage")).toEqual({ href: "/admin/events/abc/manage", internal: true })
  })

  it("gives web links their host", () => {
    expect(partLink(" https://www.twitch.tv/longhornsimracing ")).toEqual({ href: "https://www.twitch.tv/longhornsimracing", internal: false, host: "twitch.tv" })
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
