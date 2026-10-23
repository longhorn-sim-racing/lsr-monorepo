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

describe("links glued to a word, or joined by taking another out", () => {
  const gm = { officerTexts: ["Post about GM tonight"], siteHosts: SITE }

  it("come out of template values, whatever is right before them", () => {
    expect(templateValue("Win1https://evil.example/x", 60)).toBe("Win1")
    expect(templateValue("up_https://evil.example", 60)).toBe("up\\_")
    expect(templateValue("Bob\\_https://evil.example", 60)).toBe("Bob\\\\\\_")
    expect(templateValue("Xdiscord.gg/abc", 60)).toBe("X")
    expect(tidy(stripLinks("Sign up_https://evil.example/form now"))).toBe("Sign up_ now")
  })

  it("can't be joined back together by taking out an invite, a masked link or a mention", () => {
    for (const name of ["https:discord.gg/a//evil.example", "https:discord.gg/abc//evil.example/x", "https:<@123456789012345678>//evil.example/x", "https:<https://a.example>//evil.example"]) {
      expect(templateValue(name, 60)).not.toMatch(/https?:\/\//)
      expect(stripLinks(stripMentions(name))).not.toMatch(/https?:\/\//)
    }
  })

  it("break up any other scheme left in a template value, so it can't link", () => {
    expect(templateValue("Join steam://run/123 tonight")).toBe("Join steam:\u200B//run/123 tonight")
  })

  it("are found and taken out of a post unless an officer gave them; the site's own stay", () => {
    expect(linksIn("Sign up_https://evil.example/form and x1https://b.example")).toEqual(["https://evil.example/form", "https://b.example"])
    const glued = cleanPostText("GM tonight! Sign up_https://evil.example/form and bring friends", gm)
    expect(glued).toEqual({ text: "GM tonight! Sign up_ and bring friends", removed: { mentions: [], links: ["https://evil.example/form"] } })
    const joined = cleanPostText("see https:discord.gg/abc//evil.example/x now", gm)
    expect(joined).toEqual({ text: "see now", removed: { mentions: [], links: ["https://discord.gg/abc", "https://evil.example/x"] } })
    expect(cleanPostText("Rules:https://longhornsimracing.org/rules", gm).text).toBe("Rules:https://longhornsimracing.org/rules")
  })

  it("can't join the text around them into a mention that stays in a post", () => {
    const role = "<@&123456789012345678>"
    expect(cleanPostText("GM <@&123456789012345678<https://x.example>> tonight", gm)).toEqual({ text: "GM tonight", removed: { mentions: [role], links: ["https://x.example"] } })
    expect(cleanPostText("@every<https://x.example>one GM", gm)).toEqual({ text: "everyone GM", removed: { mentions: ["@everyone"], links: ["https://x.example"] } })
    expect(cleanPostText("<@&123456789012345678https://x.example>", gm)).toEqual({ text: "", removed: { mentions: [role], links: ["https://x.example"] } })
    // Nor inside a kept link's words
    expect(cleanPostText("[<@&123456789012345678https://x.example>](https://longhornsimracing.org/gm)", gm)).toEqual({ text: "[](https://longhornsimracing.org/gm)", removed: { mentions: [role], links: ["https://x.example"] } })
    // A mention an officer wrote still stays when it forms
    const asked = { officerTexts: ["Post about GM tonight and ping @everyone"], siteHosts: SITE }
    expect(cleanPostText("@every<https://x.example>one GM", asked)).toEqual({ text: "@everyone GM", removed: { mentions: [], links: ["https://x.example"] } })
  })

  it("keep a kept link inside another kept link whole", () => {
    expect(cleanPostText("<https://longhornsimracing.org/a[rules](https://longhornsimracing.org/r)>", gm).text).toBe("<https://longhornsimracing.org/a[rules](https://longhornsimracing.org/r)>")
  })

  it("never count as an officer's invite just because one is in their path or query", () => {
    const asked = { officerTexts: ["Add our invite discord.gg/abc to the post"], siteHosts: SITE }
    expect(cleanPostText("Join https://evil.example/?r=discord.gg/abc now", asked)).toEqual({ text: "Join now", removed: { mentions: [], links: ["https://evil.example/?r=discord.gg/abc"] } })
    expect(cleanPostText("Join https://discord.gg/abc now", asked).removed.links).toEqual([])
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
