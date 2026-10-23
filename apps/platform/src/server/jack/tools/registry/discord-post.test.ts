import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

vi.mock("@/server/db", () => ({ prisma: {} }))
vi.mock("@/server/jack/sql-client", () => ({ getJackSqlClient: () => null, JACK_SQL_MISSING: "missing" }))

import { kindsForTool } from "@/server/jack/proposals/registry"
import { PROMPT_SLOT } from "@/server/jack/prompt-sections/discord-post"
import { JACK_TOOLS } from "../index"

/** What the discord-post kinds add to propose_discord's definition, in characters (design §8; it's deferred, so outside the cached prefix) */
const TRACK_KINDS_MAX_CHARS = 6_000

describe("the discord-post track's tools", () => {
  it("puts discord.post and discord.rule on propose_discord, behind tool search", () => {
    expect(kindsForTool("propose_discord").map((k) => k.kind)).toEqual(["discord.post", "discord.rule"])
    const tool = JACK_TOOLS.find((t) => t.name === "propose_discord")
    expect(tool?.deferred).toBe(true)
    expect(tool?.writes).toBe(true)
    expect(tool?.description).toMatch(/discord\.post: /)
    expect(tool?.description).toMatch(/discord\.rule: .* Only an admin can apply it\./)
  })

  it("keeps the kinds' definitions small", () => {
    const total = kindsForTool("propose_discord").reduce((n, k) => n + k.description.length + JSON.stringify(z.toJSONSchema(k.schema)).length, 0)
    expect(total).toBeLessThanOrEqual(TRACK_KINDS_MAX_CHARS)
  })

  it("names the Announcements page in the prompt", () => {
    expect(PROMPT_SLOT.pages).toEqual([expect.stringMatching(/^Community → Announcements: /)])
    expect(PROMPT_SLOT.section).toMatch(/^# Posting to the club Discord/)
  })
})
