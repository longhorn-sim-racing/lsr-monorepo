/**
 * LOCAL ONLY: checks G6 (room files for Jack, and who's asking) against the real local Postgres and the
 * Claude Files HTTP fake, started in this process, where the unit tests mock both:
 * - registration puts photos (their model copy) and PDFs on Claude Files and records the ids;
 * - posting saves the officer's label; a reply through the real reply loop (a scripted fake Claude,
 *   nothing paid) gets the label, the files' line and the files themselves in its turn, and room_files
 *   lists and reads them with the real queries;
 * - a turn sends file ids, and a copy that's gone from Claude Files is uploaded again;
 * - a deck in the room loads the room's photo, and another room's deck doesn't;
 * - removing an unsent file deletes its copy on Claude Files.
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/check-jack-files-claude.ts
 *
 * Writes a throwaway officer, a room, its files (in the local files store) and messages, and deletes them
 * all at the end, pass or fail; the Claude Files connector's row goes back to how it was. It never
 * switches Claude Files on in the shared database: the client is passed in where the code takes one, and
 * the reply runs with the connector as it is (off). Refuses unless DATABASE_URL points at 127.0.0.1 or
 * localhost.
 */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

for (const file of [".env.local", ".env"]) {
  const path = resolve(process.cwd(), file)
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
// Every Claude Files call goes to the fake below, with a key the fake takes; files stay on this machine
process.env.ANTHROPIC_API_KEY = "fake-check-key"
process.env.JACK_FILE_STORE = "files"

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++
  else fail++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${detail}`}`)
}

async function main() {
  const { startFakeServer } = await import("../src/server/connectors/fakes/server")
  const { anthropicFake } = await import("../src/server/connectors/anthropic/fake/handlers")
  const fakes = await startFakeServer({ services: [anthropicFake], port: 0 })
  process.env.JACK_FAKES = "anthropic"
  process.env.JACK_FAKES_URL = fakes.url

  const { prisma } = await import("../src/server/db")
  const { claudeFilesClient, CLAUDE_FILES_CONNECTOR } = await import("../src/server/connectors/anthropic/files")
  const { jackFileStore } = await import("../src/server/jack/decks/storage")
  const { createUpload, removeUpload } = await import("../src/server/jack/files/service")
  const { registerFile } = await import("../src/server/jack/files/register")
  const { attachTurnFiles, FILES_FOLLOW } = await import("../src/server/jack/files/turn")
  const { buildConversation } = await import("../src/server/jack/history")
  const { jackMessageInclude } = await import("../src/server/jack/messages")
  const { postOfficerMessage } = await import("../src/server/jack/rooms")
  const { defaultReplyDeps } = await import("../src/server/jack/reply-loop")
  const { fakeClaude, requestProblem } = await import("../src/server/jack/fake-claude")
  const { resolveJackAsset } = await import("../src/server/jack/decks/renders")
  const { roomPhotoAssets } = await import("../src/server/jack/decks/assets")
  const { imageFile, pdfFile } = await import("../src/server/jack/files/fixtures")

  const store = jackFileStore()
  if (store.kind !== "files") throw new Error(`Expected the local files store, got ${store.kind}`)
  const claude = claudeFilesClient("fake-check-key")
  const connectorBefore = await prisma.connectorState.findUnique({ where: { id: CLAUDE_FILES_CONNECTOR } })

  const tag = `g6-check-${Date.now().toString(36)}`
  let userId: string | null = null
  const roomIds: string[] = []
  const paths: string[] = []

  try {
    userId = (await prisma.user.create({ data: { email: `${tag}@example.test`, handle: tag, displayName: "Check Officer", officerTitle: "Technology Director", department: "technology", major: "CS" } })).id
    const roomId = (await prisma.jackRoom.create({ data: { createdById: userId, title: tag } })).id
    roomIds.push(roomId)

    const attach = async (filename: string, body: Buffer) => {
      const ticket = await createUpload(userId!, { roomId, filename, size: body.length, type: "" }, store)
      if (!ticket.ok) throw new Error(`createUpload ${filename}: ${ticket.error}`)
      const row = await prisma.jackFile.findUniqueOrThrow({ where: { id: ticket.data.file.id } })
      await store.put(row.storagePath, body, ticket.data.contentType)
      const registered = await registerFile(row.id, userId!, store, claude)
      if (!registered.ok) throw new Error(`registerFile ${filename}: ${registered.error}`)
      const saved = await prisma.jackFile.findUniqueOrThrow({ where: { id: row.id } })
      paths.push(...[saved.storagePath, saved.modelCopyPath, saved.thumbPath].filter((p): p is string => Boolean(p)))
      return saved
    }

    // ---- registration: copies on Claude Files ----------------------------------------------------
    const photo = await attach("pit crew.jpg", await imageFile("jpeg", { width: 2400, height: 1600 }))
    const pdf = await attach("Sponsor packet.pdf", await pdfFile(["Sponsor packet", "Gold tier: logo on the car"]))
    const csv = await attach("signups.csv", Buffer.from("name,note\nRowan Test,see https://signup.example/x?list=1\nSam Placeholder,\n"))
    check("a photo goes up as its model copy, and its id is recorded", /^file_fake_image_/.test(photo.anthropicFileId ?? ""), String(photo.anthropicFileId))
    check("a PDF goes up as it is, and its id is recorded", /^file_fake_pdf_/.test(pdf.anthropicFileId ?? ""), String(pdf.anthropicFileId))
    check("a CSV doesn't go up", csv.anthropicFileId === null, String(csv.anthropicFileId))
    const visible = await claude.visible([photo.anthropicFileId!, pdf.anthropicFileId!])
    check("Claude Files has both", visible.size === 2, [...visible].join(", "))

    // ---- posting and a reply through the real loop --------------------------------------------------
    const fake = fakeClaude((_params, call) =>
      call === 0 ? { tools: [{ name: "room_files", input: {} }] } : call === 1 ? { tools: [{ name: "room_files", input: { file: csv.id } }] } : { text: "Rowan Test and Sam Placeholder signed up." }
    )
    const posted = await postOfficerMessage(roomId, userId, "What's in these?", {
      fileIds: [photo.id, pdf.id, csv.id],
      replyDeps: { ...defaultReplyDeps, getClient: () => fake.client, broadcast: async () => {}, budget: async () => ({ month: "test", spentUsd: 0, budgetUsd: 50 }) },
    })
    const label = `Check Officer (Technology Director · Technology · CS) [@${tag}]`
    const message = await prisma.jackMessage.findUniqueOrThrow({ where: { id: posted!.id } })
    check("posting saves who's asking", message.authorLabel === label, String(message.authorLabel))
    check("the room view carries it", posted?.author.kind === "user" && posted.author.label === label)

    const turn = fake.calls[0]?.messages.at(-1)?.content
    const blocks = Array.isArray(turn) ? (turn as { type: string; text?: string; source?: { type: string } }[]) : []
    check("the turn starts with the officer's label", blocks[0]?.text?.includes(`${label}: What's in these?`) ?? false, blocks[0]?.text?.slice(-300))
    check("the turn lists the files by id", (blocks[0]?.text ?? "").includes(`[Attached: `) && (blocks[0]?.text ?? "").includes(`id ${photo.id}`))
    check("a note says the files follow", blocks[1]?.text === FILES_FOLLOW, blocks[1]?.text)
    // JACK_FAKES covers anthropic here, so ids can't reach a real model: the photo goes inline, the PDF as text
    check("the photo follows, inline (fakes on)", blocks.some((b) => b.type === "image" && b.source?.type === "base64"))
    check("the PDF follows as its text", blocks.some((b) => b.type === "text" && (b.text ?? "").includes(`<attached_file id="${pdf.id}"`) && (b.text ?? "").includes("Gold tier")))
    const summary = blocks.find((b) => b.type === "text" && (b.text ?? "").includes(`<attached_file id="${csv.id}"`))?.text ?? ""
    check("the CSV is summarized with its link neutralized", summary.includes("[link to signup[.]example]") && !summary.includes("https://signup.example"), summary)
    check("the request is one the API takes", requestProblem(fake.calls[0]) === null, String(requestProblem(fake.calls[0])))

    const listed = toolResult(fake.calls[1])
    check("room_files lists the room's files with who posted them", listed.includes('"postedBy":"Check Officer"') && listed.includes(`"deckUrl":"https://jack.assets/room/${photo.id}"`), listed.slice(0, 300))
    const read = toolResult(fake.calls[2])
    check("room_files reads a file's text, its link as written", read.includes("https://signup.example/x?list=1"), read.slice(0, 300))
    const reply = await prisma.jackMessage.findFirst({ where: { roomId, kind: "assistant" }, orderBy: { createdAt: "desc" } })
    check("the reply finished", reply?.status === "done", reply?.status)

    // ---- a turn with ids, and a copy that's gone ---------------------------------------------------
    const rows = await prisma.jackMessage.findMany({ where: { roomId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], include: jackMessageInclude })
    const conversation = buildConversation(rows, reply!.id)
    check("the conversation hands over the turn's files", conversation.attached.map((f) => f.id).join() === [photo.id, pdf.id, csv.id].join(), conversation.attached.map((f) => f.filename).join())
    const withIds = await attachTurnFiles(conversation.history, conversation.attached, { store, claude, sendIds: true, webTools: false })
    const idBlocks = withIds.at(-1)!.content as { type: string; text?: string; source?: { type: string; file_id?: string } }[]
    check("with ids: the photo goes as an image by id", idBlocks.some((b) => b.type === "image" && b.source?.file_id === photo.anthropicFileId))
    check("with ids: the PDF goes as a document by id", idBlocks.some((b) => b.type === "document" && b.source?.file_id === pdf.anthropicFileId))
    const withWeb = (await attachTurnFiles(conversation.history, conversation.attached, { store, claude, sendIds: true, webTools: true })).at(-1)!.content as typeof idBlocks
    check(
      "with web fetch on: the PDF goes as its text, never as a document",
      !withWeb.some((b) => b.type === "document") && withWeb.some((b) => b.type === "text" && (b.text ?? "").includes(`<attached_file id="${pdf.id}"`) && (b.text ?? "").includes("room_files read"))
    )
    await claude.remove(photo.anthropicFileId!)
    await attachTurnFiles(conversation.history, conversation.attached, { store, claude, sendIds: true, webTools: false })
    const healed = await prisma.jackFile.findUniqueOrThrow({ where: { id: photo.id } })
    check("a copy that's gone is uploaded again and recorded", Boolean(healed.anthropicFileId) && healed.anthropicFileId !== photo.anthropicFileId, String(healed.anthropicFileId))

    // ---- decks ------------------------------------------------------------------------------------
    const url = new URL(`https://jack.assets/room/${photo.id}`)
    const served = await resolveJackAsset(url, { roomId })
    check("a deck in the room loads the photo (a JPEG)", served?.contentType === "image/jpeg" && served.body[0] === 0xff)
    const otherRoom = (await prisma.jackRoom.create({ data: { createdById: userId, title: `${tag}-other` } })).id
    roomIds.push(otherRoom)
    check("another room's deck doesn't", (await resolveJackAsset(url, { roomId: otherRoom })) === null)
    const assets = await roomPhotoAssets(roomId)
    check("deck_assets lists the room's photo", assets.length === 1 && assets[0].url === url.href, JSON.stringify(assets))

    // ---- removing an unsent file ------------------------------------------------------------------
    const unsent = await attach("draft.pdf", await pdfFile(["Draft"]))
    const removed = await removeUpload(unsent.id, userId, store, claude)
    const stillThere = await claude.visible([unsent.anthropicFileId!])
    check("removing an unsent file deletes its copy on Claude Files", removed.ok && stillThere.size === 0)
  } finally {
    if (roomIds.length) await prisma.jackRoom.deleteMany({ where: { id: { in: roomIds } } })
    await store.delete(paths).catch(() => {})
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {})
    if (connectorBefore) {
      const { enabled, lastSyncAt, lastError, lastErrorAt } = connectorBefore
      await prisma.connectorState.update({ where: { id: CLAUDE_FILES_CONNECTOR }, data: { enabled, lastSyncAt, lastError, lastErrorAt } })
    } else {
      await prisma.connectorState.deleteMany({ where: { id: CLAUDE_FILES_CONNECTOR } })
    }
    await fakes.close()
    await prisma.$disconnect()
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
}

/** The text of the tool results a request sends back (its last user turn) */
function toolResult(params: { messages: { content: unknown }[] } | undefined): string {
  const content = params?.messages.at(-1)?.content
  if (!Array.isArray(content)) return ""
  return content
    .flatMap((block: { type?: string; content?: unknown }) => (block.type === "tool_result" ? [typeof block.content === "string" ? block.content : JSON.stringify(block.content)] : []))
    .join("\n")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
