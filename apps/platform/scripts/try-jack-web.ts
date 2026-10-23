/**
 * LOCAL ONLY, NO CLAUDE API: shows Jack 2.0's web search and fetch end to end without spending anything
 * (G8). It runs the real reply loop (runRoom) in a new local room with JACK_WEB_TOOLS=on, against a
 * scripted fake Claude (fake-claude.ts) that answers like the real API would:
 *
 *   1. "Who sponsors other college sim racing clubs?": a web search, an answer citing two of its results.
 *   2. "Open the second link": a tool search that finds web_links, web_links (reading the first reply's
 *      parts from the database), then a web fetch of the second link it returned, and an answer.
 *
 * It prints each request's tools (web search and fetch, url_sources, tool search), each reply's parts, the
 * history's tool note and the cost. The room is deleted at the end unless --keep is given; with --keep,
 * open the printed link to see the web_sources parts in the room (light and dark, 390 px).
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/try-jack-web.ts
 *   pnpm --filter @lsr/platform exec tsx scripts/try-jack-web.ts --keep
 *
 * Refuses unless DATABASE_URL points at 127.0.0.1 or localhost. Needs an officer or admin there (pnpm set-role).
 */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages"
import type { FakeTurn } from "../src/server/jack/fake-claude"

for (const file of [".env.local", ".env"]) {
  const path = resolve(__dirname, "..", file)
  if (!existsSync(path)) continue
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (process.env[key] === undefined) process.env[key] = value
  }
}

let host = ""
try {
  host = new URL(process.env.DATABASE_URL ?? "").hostname
} catch {}
if (!["127.0.0.1", "localhost"].includes(host)) {
  console.error(`Refusing to run: DATABASE_URL points at "${host || "nothing"}", not the local database.`)
  process.exit(1)
}
process.env.JACK_WEB_TOOLS = "on"
const keep = process.argv.includes("--keep")

const PAGES = [
  { url: "https://www.iracing.com/college-racing/", title: "iRacing college racing" },
  { url: "https://www.fia.com/esports", title: "FIA esports" },
  { url: "https://example.org/sim-racing-clubs", title: "Sim racing clubs roundup" },
]

async function main() {
  const { prisma } = await import("../src/server/db")
  const { runRoom, defaultReplyDeps } = await import("../src/server/jack/reply-loop")
  const { parseToolParts } = await import("../src/lib/jack/parts")
  const { toolNote } = await import("../src/server/jack/history")
  const fake = await import("../src/server/jack/fake-claude")

  /** The second link web_links returned, read from the tool result the loop sent back */
  const secondLink = (params: BetaMessageStreamParams): string => {
    const results = params.messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content)).filter((b) => b.type === "tool_result")
    const body = results.map((b) => (typeof b.content === "string" ? b.content : "")).find((text) => text.includes('"replies"'))
    const link = body ? (JSON.parse(body) as { replies: { links: { n: number; url: string }[] }[] }).replies[0]?.links.find((l) => l.n === 2) : undefined
    if (!link) throw new Error("web_links didn't return a second link")
    return link.url
  }

  // One turn per Claude call: the first reply is call 0; the follow-up is calls 1 (search for web_links, call it) and 2
  const claude = fake.fakeClaude((params, call): FakeTurn => {
    if (call === 0) {
      return {
        blocks: [
          ...fake.fakeWebSearch("college sim racing club sponsors", PAGES),
          fake.fakeCitedText("iRacing runs a college racing program", [PAGES[0]]),
          { type: "text", text: ", and the FIA backs university esports", citations: null } as never,
          fake.fakeCitedText(" through its esports commission.", [PAGES[1]]),
        ],
        usage: { input: 6_000, output: 300 },
      }
    }
    if (call === 1) {
      return { blocks: fake.fakeToolSearch("earlier web links", fake.searchDeferredTools(params, "web links earlier replies")), tools: [{ name: "web_links", input: {} }] }
    }
    return {
      blocks: fake.fakeWebFetch(secondLink(params), { title: "FIA esports", text: "The FIA's esports commission works with universities." }),
      text: "The FIA page says its esports commission works with universities.",
    }
  })

  const officer = await prisma.user.findFirst({ where: { roles: { some: { role: { key: { in: ["admin", "officer"] } } } } }, orderBy: { createdAt: "asc" } })
  if (!officer) throw new Error("No officer or admin in the local database; run pnpm set-role first.")
  const room = await prisma.jackRoom.create({ data: { title: "Web try-out", createdById: officer.id } })
  const deps = { ...defaultReplyDeps, getClient: () => claude.client, broadcast: async () => {} }

  try {
    for (const question of ["Who sponsors other college sim racing clubs?", "Open the second link"]) {
      await prisma.jackMessage.create({ data: { roomId: room.id, kind: "user", authorUserId: officer.id, content: question } })
      console.log(`\n${officer.displayName}: ${question}`)
      await runRoom(room.id, deps)
      const [reply] = await prisma.jackMessage.findMany({ where: { roomId: room.id, kind: "assistant" }, orderBy: { createdAt: "desc" }, take: 1 })
      const parts = parseToolParts(reply.toolCalls)
      for (const part of parts) {
        console.log(`  [${part.status}] ${part.name}: ${part.label}`)
        for (const display of part.displays) if (display.kind === "web_sources") for (const s of display.sources) console.log(`      ${s.host}  ${s.title}  ${s.url}`)
      }
      console.log(`  Jack: ${reply.content}`)
      console.log(`  ${toolNote(parts)}`)
      console.log(`  $${reply.costUsd} (tokens plus $0.01 a search)`)
    }

    const first = claude.calls[0]
    console.log("\nThe first request's tools, after Jack's own (in registry order):")
    console.log(JSON.stringify((first.tools ?? []).slice(-3), null, 2))
    if (keep) console.log(`\nKept: open http://localhost:3000/admin/jack/${room.id}`)
  } finally {
    if (!keep) await prisma.jackRoom.delete({ where: { id: room.id } })
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
