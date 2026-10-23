/**
 * Checks room files end to end against a RUNNING app (#188, G5), so the routes run as built (for
 * example, that pdf.js reads PDFs inside the production server, not only in tests):
 *
 *   pnpm --filter @lsr/platform build
 *   JACK_FILE_STORE=files pnpm --filter @lsr/platform start -p 3115
 *   pnpm --filter @lsr/platform exec tsx scripts/check-jack-files.ts --base-url=http://localhost:3115
 *
 * For each kind of file it starts an upload (the service createJackUpload calls), sends the bytes the
 * way the browser does (the signed upload URL, or the local upload route with the files store),
 * registers it through POST /api/admin/jack/files/[id]/register, and reads it back through GET
 * /api/admin/jack/files/[id], checking the extracted text, the photo copies, the refusals and the
 * response headers. Then it posts a message with the files (the reply comes from the scripted fake
 * Claude; the API is never called).
 *
 * The script and the server must use the same store: it sets JACK_FILE_STORE=files for itself unless
 * JACK_FILE_STORE is already set (pass the same value to both).
 *
 * Local only: refuses unless NEXT_PUBLIC_SUPABASE_URL, DATABASE_URL and --base-url are this machine.
 * Creates a throwaway officer (random password, never printed) and a room, and deletes them, their
 * files and the stored copies at the end.
 */
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import sharp from "sharp"
import { localDatabaseProblem } from "../src/server/jack/eval-support"

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
;(process.env as Record<string, string | undefined>).JACK_FILE_STORE ??= "files"
// db.ts logs every query unless NODE_ENV is production; keep the run readable
;(process.env as Record<string, string | undefined>).NODE_ENV ??= "production"

const LOCAL_HOSTS = ["127.0.0.1", "localhost"]
const hostOf = (url: string | undefined) => {
  try {
    return new URL(url ?? "").hostname
  } catch {
    return ""
  }
}
const baseUrl = (process.argv.find((arg) => arg.startsWith("--base-url="))?.slice("--base-url=".length) ?? "http://localhost:3000").replace(/\/+$/, "")
for (const [name, url] of [["NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL], ["--base-url", baseUrl]] as const) {
  if (!LOCAL_HOSTS.includes(hostOf(url))) {
    console.error(`Refusing to run: ${name} points at "${hostOf(url) || "nothing"}", not this machine.`)
    process.exit(1)
  }
}
const databaseProblem = localDatabaseProblem("DATABASE_URL", process.env.DATABASE_URL)
if (databaseProblem) {
  console.error(`Refusing to run: ${databaseProblem}`)
  process.exit(1)
}

let failed = false
function check(step: string, ok: boolean, note?: string) {
  if (!ok) failed = true
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${note ? `  (${note})` : ""}`)
}

async function main() {
  const { createClient } = await import("@supabase/supabase-js")
  const { createServerClient } = await import("@supabase/ssr")
  const { prisma } = await import("../src/server/db")
  const { jackFileStore } = await import("../src/server/jack/decks/storage")
  const { createUpload } = await import("../src/server/jack/files/service")
  const { filePaths, storedPaths } = await import("../src/server/jack/files/paths")
  const { docxFile, imageFile, pdfFile, xlsxFile } = await import("../src/server/jack/files/fixtures")
  const { postOfficerMessage } = await import("../src/server/jack/rooms")
  const { defaultReplyDeps } = await import("../src/server/jack/reply-loop")
  const { fakeClaude } = await import("../src/server/jack/fake-claude")

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  const admin = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, noSession)
  const store = jackFileStore()
  console.log(`App: ${baseUrl}  Store: ${store.kind}`)
  if (store.kind !== "files" && store.kind !== "supabase") throw new Error(`The ${store.kind} store can't take uploads; run with JACK_FILE_STORE=files (script and server).`)

  const tag = `files-check-${Date.now().toString(36)}`
  const email = `${tag}@example.com`
  const password = randomBytes(24).toString("base64url")
  let userId: string | null = null
  let roomId: string | null = null

  try {
    const officerRole = await prisma.role.findUnique({ where: { key: "officer" } })
    if (!officerRole) throw new Error('No "officer" role in the local database; run the seed first.')
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: "Files Check" } })
    if (created.error || !created.data.user) throw new Error(`Couldn't create the test officer: ${created.error?.message}`)
    userId = created.data.user.id
    await prisma.user.create({ data: { id: userId, email, handle: tag, displayName: "Files Check" } })
    await prisma.userRole.create({ data: { userId, roleId: officerRole.id } })
    roomId = (await prisma.jackRoom.create({ data: { createdById: userId, title: tag } })).id

    // Signs in the way the site does, and keeps the session cookies it sets
    const jar = new Map<string, string>()
    const ssr = createServerClient(SUPABASE_URL, ANON_KEY, {
      cookies: {
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        setAll: (cookies) => cookies.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
      },
    })
    const signedIn = await ssr.auth.signInWithPassword({ email, password })
    if (signedIn.error) throw new Error(`Couldn't sign in: ${signedIn.error.message}`)
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ")
    const app = (path: string, init: RequestInit = {}, withCookie = true) => fetch(`${baseUrl}${path}`, { ...init, redirect: "manual", headers: { ...(withCookie ? { cookie } : {}), ...init.headers } })

    const uploadAndRegister = async (filename: string, body: Buffer, type = "") => {
      const ticket = await createUpload(userId!, { roomId: roomId!, filename, size: body.length, type })
      if (!ticket.ok) return { ticketError: ticket.error } as const
      const form = new FormData()
      form.append("cacheControl", "3600")
      form.append("", new Blob([new Uint8Array(body)], { type: ticket.data.contentType }))
      const absolute = /^https?:/.test(ticket.data.url)
      const put = absolute
        ? await fetch(ticket.data.url, { method: "PUT", body: form, headers: { "x-upsert": "false", apikey: ANON_KEY } })
        : await app(ticket.data.url, { method: "PUT", body: form, headers: { "x-upsert": "false" } })
      const registered = await app(`/api/admin/jack/files/${ticket.data.file.id}/register`, { method: "POST" })
      const answer = (await registered.json().catch(() => null)) as { ok: boolean; error?: string } | null
      const row = await prisma.jackFile.findUnique({ where: { id: ticket.data.file.id } })
      return { id: ticket.data.file.id, putStatus: put.status, status: registered.status, answer, row } as const
    }

    // ---- documents: text extracted inside the running server ------------------------------
    const pdf = await uploadAndRegister("LSC rules.pdf", await pdfFile(["Lone Star Cup rules", "Page two: penalties for track limits"]), "application/pdf")
    check("PDF uploads through the route the browser uses", "putStatus" in pdf && pdf.putStatus === 200, "putStatus" in pdf ? String(pdf.putStatus) : pdf.ticketError)
    check(
      "PDF registers READY with its text and page count (pdf.js in the built server)",
      "row" in pdf && pdf.row?.status === "READY" && pdf.row.pageCount === 2 && Boolean(pdf.row.text?.includes("penalties for track limits")),
      "row" in pdf ? `${pdf.row?.status} ${pdf.row?.textStatus} pages=${pdf.row?.pageCount}` : ""
    )

    const docx = await uploadAndRegister("GM 2 minutes.docx", docxFile(["Decided: buy a second wheelbase", "Owner: Gray"]))
    check("DOCX registers READY with its text", "row" in docx && docx.row?.status === "READY" && Boolean(docx.row.text?.includes("second wheelbase")), "row" in docx ? `${docx.row?.textStatus}` : "")

    const xlsx = await uploadAndRegister("budget.xlsx", await xlsxFile({ Budget: [["Item", "Cost"], ["Tires", 120], ["Total", { formula: "SUM(B2:B2)", result: 120 }]] }))
    check("XLSX registers READY with the saved formula results", "row" in xlsx && Boolean(xlsx.row?.text?.includes("Total,120")), "row" in xlsx ? `${xlsx.row?.textStatus}` : "")

    // More rows than the cap: exceljs's streaming reader (inside the built server) stops at 5,000
    const laps = await xlsxFile({ Laps: Array.from({ length: 6_000 }, (_, i) => [`Driver ${i % 40}`, i, 90 + (i % 30) / 7]) })
    const bigXlsx = await uploadAndRegister("laps.xlsx", laps)
    const lapRows = "row" in bigXlsx ? (bigXlsx.row?.text?.split("\n").filter((line) => line.startsWith("Driver ")).length ?? 0) : 0
    check("a 6,000-row XLSX is read row by row up to the 5,000-row cap", "row" in bigXlsx && bigXlsx.row?.textStatus === "truncated" && lapRows === 5_000, "row" in bigXlsx ? `${bigXlsx.row?.textStatus} rows=${lapRows}` : "")

    const vtt = await uploadAndRegister("GM 2.vtt", Buffer.from("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Dylan>Welcome to GM 2.</v>\n"))
    check("VTT registers READY as speaker-tagged text", "row" in vtt && vtt.row?.text === "[0:01] Dylan: Welcome to GM 2.", "row" in vtt ? `${vtt.row?.text}` : "")

    const csv = await uploadAndRegister("signups.csv", Buffer.from("name,email\nAda,ada@example.com\n"), "application/vnd.ms-excel")
    check("CSV (as Windows labels it) registers READY", "row" in csv && csv.row?.status === "READY" && csv.row.contentType === "text/csv")

    // ---- a photo: model copy without EXIF, thumbnail, served inline ------------------------
    const photoBytes = await imageFile("jpeg", { width: 2600, height: 1300 })
    const photo = await uploadAndRegister("IMG_0042.JPG", photoBytes, "image/jpeg")
    const photoRow = "row" in photo ? photo.row : null
    check("photo registers READY with its size", photoRow?.status === "READY" && photoRow.width === 2600 && photoRow.height === 1300, `${photoRow?.status} ${photoRow?.width}x${photoRow?.height}`)
    if (photoRow?.modelCopyPath) {
      const model = await sharp((await store.get(photoRow.modelCopyPath))!).metadata()
      check("its model copy is a 2000 px JPEG with no EXIF", model.format === "jpeg" && model.width === 2000 && !model.exif, `${model.format} ${model.width} exif=${Boolean(model.exif)}`)
    } else check("its model copy is a 2000 px JPEG with no EXIF", false, "no model copy")

    // ---- refusals ----------------------------------------------------------------------------
    const fake = await uploadAndRegister("totally-a-photo.png", Buffer.from("<html><script>alert(1)</script></html>"), "image/png")
    check(
      "an HTML page named .png is refused at registration (magic bytes)",
      "row" in fake && fake.status === 422 && fake.row?.status === "FAILED" && Boolean(fake.answer?.error?.includes("PNG")),
      "row" in fake ? `${fake.status} ${fake.answer?.error}` : ""
    )
    const svg = await uploadAndRegister("logo.svg", Buffer.from("<svg/>"), "image/svg+xml")
    check("an SVG is refused before any upload", "ticketError" in svg && Boolean(svg.ticketError?.includes("SVG")), "ticketError" in svg ? svg.ticketError : "")

    // ---- serving ------------------------------------------------------------------------------
    if ("id" in pdf) {
      const res = await app(`/api/admin/jack/files/${pdf.id}`)
      const body = Buffer.from(await res.arrayBuffer())
      check(
        "a PDF is served as a locked-down download",
        res.status === 200 &&
          res.headers.get("x-content-type-options") === "nosniff" &&
          res.headers.get("content-security-policy") === "sandbox" &&
          res.headers.get("cache-control") === "private, no-store" &&
          Boolean(res.headers.get("content-disposition")?.startsWith('attachment; filename="LSC rules.pdf"')) &&
          body.subarray(0, 5).toString() === "%PDF-",
        `${res.status} ${res.headers.get("content-disposition")}`
      )
      const anonymous = await app(`/api/admin/jack/files/${pdf.id}`, {}, false)
      check("signed out, it's refused", anonymous.status === 403, String(anonymous.status))
    }
    if ("id" in photo) {
      const original = await app(`/api/admin/jack/files/${photo.id}`)
      check("the photo is shown inline", original.status === 200 && Boolean(original.headers.get("content-disposition")?.startsWith("inline")), original.headers.get("content-disposition") ?? "")
      const thumb = await app(`/api/admin/jack/files/${photo.id}?variant=thumb`)
      const thumbMeta = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata()
      check(
        "its thumbnail is a small JPEG cached for good",
        thumb.headers.get("cache-control") === "private, max-age=31536000, immutable" && thumbMeta.format === "jpeg" && thumbMeta.width === 320,
        `${thumb.headers.get("cache-control")} ${thumbMeta.width}`
      )
    }
    if ("id" in fake) {
      const refused = await app(`/api/admin/jack/files/${fake.id}`)
      check("a refused file is never served", refused.status === 404, String(refused.status))
    }

    // ---- posting a message with files -------------------------------------------------------
    const ready = [pdf, photo, csv].flatMap((f) => ("id" in f && f.id && f.row?.status === "READY" ? [f.id] : []))
    const fakeReply = fakeClaude([{ text: "Got the files." }])
    const replyDeps = { ...defaultReplyDeps, getClient: () => fakeReply.client, budget: async () => ({ month: "check", spentUsd: 0, budgetUsd: 1 }) }
    const message = await postOfficerMessage(roomId, userId, "Here are the files", { replyDeps, fileIds: ready })
    check(
      "a message posts with its files, in order",
      JSON.stringify(message?.files?.map((f) => f.id)) === JSON.stringify(ready) && Boolean(message?.files?.[1]?.thumbUrl),
      `${message?.files?.length ?? 0} files`
    )
    const again = await postOfficerMessage(roomId, userId, "Again", { replyDeps, fileIds: ready.slice(0, 1) }).then(
      () => "posted",
      (error: Error) => error.constructor.name
    )
    check("a posted file can't be posted again", again === "AttachmentError", again)

    // ---- the room page renders the composer and the posted files ---------------------------
    const page = await app(`/admin/jack/${roomId}`)
    const html = await page.text()
    check(
      "the room page renders the attach button and the posted photo's thumbnail",
      page.status === 200 && html.includes("Attach files (up to 10)") && "id" in photo && html.includes(`/api/admin/jack/files/${photo.id}?variant=thumb`),
      String(page.status)
    )
  } finally {
    // ---- clean up ------------------------------------------------------------------------------
    if (roomId) {
      const files = await prisma.jackFile.findMany({ where: { roomId }, select: { id: true, roomId: true, storagePath: true, modelCopyPath: true, thumbPath: true } })
      await store.delete([...new Set(files.flatMap((file) => [...storedPaths(file), ...filePaths(file)]))]).catch((e) => console.error("Cleanup: stored files", e))
      await prisma.jackRoom.delete({ where: { id: roomId } }).catch((e) => console.error("Cleanup: room", e))
    }
    if (userId) {
      await prisma.user.delete({ where: { id: userId } }).catch((e) => console.error("Cleanup: user", e))
      const { error } = await admin.auth.admin.deleteUser(userId)
      if (error) console.error(`Cleanup: auth user: ${error.message}`)
    }
    await prisma.$disconnect()
  }

  console.log(failed ? "\nSome checks FAILED." : "\nAll checks passed.")
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
