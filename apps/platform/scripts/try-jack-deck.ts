/**
 * LOCAL ONLY: asks Jack for slides or a graphic the way a room does, then saves every slide of every
 * deck in that room as a PNG to look at (#177). Calls the real Claude API, so it costs money: about
 * $0.20 to $1 per request on Jack, roughly twice that on Lift.
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/try-jack-deck.ts "Make a 5-slide deck for GM 2"
 *   pnpm --filter @lsr/platform exec tsx scripts/try-jack-deck.ts --as=lift "An Instagram story for recruiting"
 *   pnpm --filter @lsr/platform exec tsx scripts/try-jack-deck.ts --room=<id> "Make slide 2 light"   # a follow-up
 *
 * Opens a new room (titled "Deck try-out") as the first officer or admin, unless --room continues one.
 * The answer runs through the real reply loop (runRoom) with Realtime broadcasts switched off. Slides
 * go to .jack-renders/try/<room id>/. Needs ANTHROPIC_API_KEY. Refuses unless DATABASE_URL points at
 * 127.0.0.1 or localhost.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

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
if (!process.env.ANTHROPIC_API_KEY?.trim()) {
  console.error("Set ANTHROPIC_API_KEY first.")
  process.exit(1)
}

const args = process.argv.slice(2)
const persona = (args.find((a) => a.startsWith("--as="))?.slice(5) ?? "jack") as "jack" | "lift" | "stand"
const roomArg = args.find((a) => a.startsWith("--room="))?.slice(7)
const prompt = args.filter((a) => !a.startsWith("--")).join(" ").trim()
if (!prompt) {
  console.error('Say what to make, e.g. "Make a 5-slide deck for GM 2"')
  process.exit(1)
}

async function main() {
  const { prisma } = await import("../src/server/db")
  const { runRoom, defaultReplyDeps } = await import("../src/server/jack/reply-loop")
  const { parseToolParts } = await import("../src/lib/jack/parts")
  const { listDecks, getDeck } = await import("../src/server/jack/decks/service")
  const { getRenderFile, ensureRender } = await import("../src/server/jack/decks/renders")
  const { closeRenderer } = await import("../src/server/jack/decks/renderer")

  const officer = await prisma.user.findFirst({ where: { roles: { some: { role: { key: { in: ["admin", "officer"] } } } } }, orderBy: { createdAt: "asc" } })
  if (!officer) throw new Error("No officer or admin in the local database; run pnpm set-role first.")

  const room = roomArg
    ? await prisma.jackRoom.findUniqueOrThrow({ where: { id: roomArg } })
    : await prisma.jackRoom.create({ data: { title: "Deck try-out", persona, createdById: officer.id } })
  if (roomArg && room.persona !== persona && args.some((a) => a.startsWith("--as="))) await prisma.jackRoom.update({ where: { id: room.id }, data: { persona } })
  await prisma.jackMessage.create({ data: { roomId: room.id, kind: "user", authorUserId: officer.id, content: prompt } })
  console.log(`Room ${room.id} (${persona}), asking as ${officer.displayName}: ${prompt}\n`)

  const started = Date.now()
  await runRoom(room.id, { ...defaultReplyDeps, broadcast: async () => {} }, { startedAt: started })
  const seconds = ((Date.now() - started) / 1000).toFixed(0)

  const replies = await prisma.jackMessage.findMany({ where: { roomId: room.id, kind: "assistant" }, orderBy: { createdAt: "desc" }, take: 1 })
  for (const reply of replies) {
    for (const part of parseToolParts(reply.toolCalls)) console.log(`  [${part.status}] ${part.name}: ${part.label}${part.ms ? ` (${(part.ms / 1000).toFixed(1)} s)` : ""}`)
    console.log(`\n${reply.content}\n`)
    console.log(`${reply.status}, ${reply.model}, $${reply.costUsd}, ${reply.inputTokens} in + ${reply.cacheReadTokens} cache read, ${reply.outputTokens} out, ${seconds} s`)
  }

  for (const summary of await listDecks({ roomId: room.id })) {
    const deck = await getDeck(summary.id)
    if (!deck) continue
    const dir = resolve(__dirname, `../.jack-renders/try/${room.id}/${summary.id.slice(0, 8)}-v${deck.version}`)
    mkdirSync(dir, { recursive: true })
    console.log(`\nDeck "${deck.title}" ${deck.id}, version ${deck.version}, ${deck.content.slides.length} slides -> ${dir}`)
    for (const [i, slide] of deck.content.slides.entries()) {
      const source = { size: deck.size, css: deck.content.css, html: slide.html }
      const { issues } = await ensureRender(source)
      writeFileSync(resolve(dir, `${String(i + 1).padStart(2, "0")}.png`), (await getRenderFile(source, "png")).body)
      writeFileSync(resolve(dir, `${String(i + 1).padStart(2, "0")}.view.jpg`), (await getRenderFile(source, "view")).body)
      console.log(`  ${i + 1}: ${issues.length ? issues.join(" | ") : "no layout problems"}`)
    }
    if (deck.content.css) writeFileSync(resolve(dir, "deck.css"), deck.content.css)
    writeFileSync(resolve(dir, "slides.html"), deck.content.slides.map((s, i) => `<!-- slide ${i + 1} -->\n${s.html}\n${s.notes ? `<!-- notes: ${s.notes} -->\n` : ""}`).join("\n"))
  }
  await closeRenderer()
  await prisma.$disconnect()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
