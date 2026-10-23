import { describe, expect, it } from "vitest"
import { cleanPostText, clipText, escapeMarkdown, linksIn, mentionsIn, siteHostsOf, stripLinks, stripMentions, templateValue, tidy } from "./text"

const SITE = ["longhornsimracing.org"]

describe("mentions", () => {
  it("finds everything that would ping: @everyone, @here, users and roles, but not channel links", () => {
    expect(mentionsIn("Hey @everyone and @here, <@123456789012345678> <@!123456789012345678> <@&223456789012345678> in <#323456789012345678>")).toEqual([
      "@everyone",
      "@here",
      "<@123456789012345678>",
      "<@!123456789012345678>",
      "<@&223456789012345678>",
    ])
  })

  it("strips them: @everyone becomes a plain word, user and role mentions go, channel links stay", () => {
    expect(tidy(stripMentions("@everyone GM tonight <@&223456789012345678> in <#323456789012345678> @here"))).toBe("everyone GM tonight in <#323456789012345678> here")
  })
})

describe("links", () => {
  it("finds masked, <angle> and bare links, without the sentence's last punctuation", () => {
    expect(linksIn("See [the form](https://forms.example/a?b=1), <https://x.example/y> and https://z.example/path. Also (https://w.example/q).")).toEqual([
      "https://forms.example/a?b=1",
      "https://x.example/y",
      "https://z.example/path",
      "https://w.example/q",
    ])
  })

  it("strips them: a masked link keeps its words, the rest go", () => {
    expect(tidy(stripLinks("Sign up [here](https://evil.example/x) or at https://evil.example/y. Thanks <https://evil.example/z>"))).toBe("Sign up here or at. Thanks")
  })
})

describe("cleanPostText", () => {
  const officer = ["Post that GM 2 is Monday at 6, link https://forms.example/signup and ping @everyone"]

  it("keeps the mentions and links an officer's own message has, and links to the club site", () => {
    const out = cleanPostText("@everyone GM 2 is Monday at 6! Sign up: https://forms.example/signup. Details: https://www.longhornsimracing.org/events/gm-2", { officerTexts: officer, siteHosts: SITE })
    expect(out.text).toBe("@everyone GM 2 is Monday at 6! Sign up: https://forms.example/signup. Details: https://www.longhornsimracing.org/events/gm-2")
    expect(out.removed).toEqual({ mentions: [], links: [] })
  })

  it("takes out the ones no officer gave: outside links (masked links keep their words) and pings", () => {
    const out = cleanPostText("GM 2 is Monday <@&223456789012345678>! Claim your spot [here](https://claim.example/x?emails=all) or https://other.example/y @here", { officerTexts: officer, siteHosts: SITE })
    expect(out.text).toBe("GM 2 is Monday! Claim your spot here or here")
    expect(out.removed.mentions).toEqual(["<@&223456789012345678>", "@here"])
    expect(out.removed.links).toEqual(["https://claim.example/x?emails=all", "https://other.example/y"])
  })

  it("compares links loosely (www, a trailing slash) but never by host alone", () => {
    const keep = cleanPostText("https://WWW.forms.example/signup/", { officerTexts: officer, siteHosts: SITE })
    expect(keep.removed.links).toEqual([])
    const other = cleanPostText("https://forms.example/other-path", { officerTexts: officer, siteHosts: SITE })
    expect(other.removed.links).toEqual(["https://forms.example/other-path"])
    expect(other.text).toBe("")
  })

  it("treats a subdomain of the site as the site, and never a look-alike host", () => {
    expect(cleanPostText("https://shop.longhornsimracing.org/x", { officerTexts: [], siteHosts: SITE }).removed.links).toEqual([])
    expect(cleanPostText("https://longhornsimracing.org.evil.example/x", { officerTexts: [], siteHosts: SITE }).removed.links).toHaveLength(1)
  })

  it("keeps line breaks the writer meant", () => {
    expect(cleanPostText("Line one\n\nLine two\n- a\n- b", { officerTexts: [], siteHosts: SITE }).text).toBe("Line one\n\nLine two\n- a\n- b")
  })

  it("never skips a link because its text only looks like a masked link", () => {
    const gm = ["Post about GM 2 on Monday"]
    const broken = cleanPostText("See [details](visit https://evil.example/a)", { officerTexts: gm, siteHosts: SITE })
    expect(broken.removed.links).toEqual(["https://evil.example/a"])
    expect(broken.text).not.toContain("evil.example")
    const titled = cleanPostText('See [details](https://evil.example/a "tip")', { officerTexts: gm, siteHosts: SITE })
    expect(titled.removed.links).toEqual(["https://evil.example/a"])
    expect(titled.text).toBe("See details")
  })

  it("keeps a masked link to the site (with a title too), but not an outside link in its words", () => {
    const kept = cleanPostText('Read [the rules](https://longhornsimracing.org/rules "LSC rules") and [https://evil.example/x](https://longhornsimracing.org/a)', { officerTexts: [], siteHosts: SITE })
    expect(kept.text).toBe('Read [the rules](https://longhornsimracing.org/rules "LSC rules") and [](https://longhornsimracing.org/a)')
    expect(kept.removed.links).toEqual(["https://evil.example/x"])
  })

  it("takes out a bare link right next to a kept one, and keeps the kept one", () => {
    const out = cleanPostText("https://evil.example/a<https://longhornsimracing.org/b>", { officerTexts: [], siteHosts: SITE })
    expect(out.text).toBe("<https://longhornsimracing.org/b>")
    expect(out.removed.links).toEqual(["https://evil.example/a"])
  })

  it("keeps a Discord invite only when an officer's message has it, written with or without https://", () => {
    const out = cleanPostText("Join discord.gg/scam or https://discord.com/invite/other", { officerTexts: officer, siteHosts: SITE })
    expect(out.text).toBe("Join or")
    expect(out.removed.links).toEqual(["https://discord.com/invite/other", "https://discord.gg/scam"])
    const asked = ["Add our invite discord.gg/LSRclub to the post"]
    expect(cleanPostText("Join us: https://discord.gg/LSRclub", { officerTexts: asked, siteHosts: SITE }).removed.links).toEqual([])
    expect(cleanPostText("Join us: discord.gg/LSRclub", { officerTexts: asked, siteHosts: SITE }).text).toBe("Join us: discord.gg/LSRclub")
    expect(cleanPostText("Join us: discord.gg/lsrclub", { officerTexts: asked, siteHosts: SITE }).removed.links).toEqual(["https://discord.gg/lsrclub"])
  })

  it("ignores stand-in characters in the text", () => {
    expect(cleanPostText("a\uE0000\uE001b https://evil.example/x", { officerTexts: [], siteHosts: SITE }).text).toBe("a0b")
  })
})

describe("invites", () => {
  it("count as links, and come out of template values", () => {
    expect(linksIn("join discord.gg/scam or discordapp.com/invite/x-y")).toEqual(["https://discord.gg/scam", "https://discord.gg/x-y"])
    expect(templateValue("Live! join discord.gg/scam now")).toBe("Live! join now")
    expect(tidy(stripLinks("join DISCORD.GG/abc today"))).toBe("join today")
  })
})

describe("template values", () => {
  it("escape Markdown so outside text shows as written", () => {
    expect(escapeMarkdown("**bold** _x_ ~~s~~ `c` ||spoiler|| [a](b) <@1>")).toBe("\\*\\*bold\\*\\* \\_x\\_ \\~\\~s\\~\\~ \\`c\\` \\|\\|spoiler\\|\\| \\[a\\](b) \\<@1\\>")
    expect(escapeMarkdown("# Heading")).toBe("\\# Heading")
    expect(escapeMarkdown("1. First")).toBe("1\\. First")
  })

  it("are one line, without mentions or links, escaped and clipped", () => {
    const title = "@everyone LIVE: **Monza** night\nrace https://bit.example/x [free](https://evil.example)"
    expect(templateValue(title, 200)).toBe("everyone LIVE: \\*\\*Monza\\*\\* night race free")
    expect(templateValue("x".repeat(300), 10)).toBe("xxxxxxxxx…")
    expect(templateValue(null)).toBe("")
  })

  it("clip with an ellipsis", () => {
    expect(clipText("abcdef", 4)).toBe("abc…")
    expect(clipText("abc", 4)).toBe("abc")
  })

  it("list the site's hosts once", () => {
    expect(siteHostsOf("https://www.longhornsimracing.org", "https://longhornsimracing.org", null, "http://localhost:3000")).toEqual(["longhornsimracing.org", "localhost"])
  })
})
