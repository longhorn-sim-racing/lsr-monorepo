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
