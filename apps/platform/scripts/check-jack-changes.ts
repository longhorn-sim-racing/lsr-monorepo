/**
 * LOCAL ONLY: checks the changes track's proposals (src/server/jack/proposals/changes) end to end against
 * the real local Postgres, where the unit tests use fakes. Each kind is proposed and applied through the
 * real framework (claim, staleness, apply, notes, audit) and the real services, and what it wrote is read
 * back: what only a database shows, such as the JSON path filter that stops a notification going out
 * twice, the services' transactions and locks, cascades, and the proposal ids on every audit entry.
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/check-jack-changes.ts
 *
 * Uses an existing officer (read only). Everything else it makes is throwaway and deleted at the end,
 * pass or fail: a room (with its proposals, notes and files), two members, an event, a season, a news
 * post and its tag, results records, entry forms, notifications, check-ins, and every audit entry the
 * room led to. Files go to an in-memory store; no email is sent (the members have emails switched off,
 * and notifications go in-app). Refuses unless DATABASE_URL points at 127.0.0.1 or localhost.
 */
import { createHash, randomUUID } from "node:crypto"
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
// No email from this script, whatever the env has
delete process.env.RESEND_API_KEY

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++
  else fail++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${detail}`}`)
}

async function main() {
  const { prisma } = await import("../src/server/db")
  const { setJackFileStore } = await import("../src/server/jack/decks/storage")
  const { memoryStore } = await import("../src/server/jack/decks/memory-store")
  const service = await import("../src/server/jack/proposals/service")
  const store = memoryStore("files")
  setJackFileStore(store)

  const officer = await prisma.user.findFirst({ where: { roles: { some: { role: { key: { in: ["admin", "officer"] } } } } }, orderBy: { createdAt: "asc" } })
  if (!officer) throw new Error("No officer or admin in this database: pnpm set-role <email> admin")
  const me = { id: officer.id, displayName: officer.displayName }
  const deps = { ...service.defaultProposalDeps, broadcast: async () => {} }
  const tag = `cjc${Date.now().toString(36)}`

  const made = { users: [] as string[], posts: [] as string[], tagSlugs: [] as string[], uploads: [] as string[], guids: [] as string[], seasons: [] as string[], league: null as string | null, event: null as string | null }
  const room = await prisma.jackRoom.create({ data: { createdById: officer.id, title: `check-jack-changes ${tag}` } })

  const propose = async (kind: string, payload: unknown) => {
    const outcome = await service.createProposal({ kind, payload, roomId: room.id, proposedFor: { userId: officer.id, displayName: officer.displayName } }, deps)
    if (!outcome.ok) throw new Error(`${kind} wasn't proposed: ${outcome.error}`)
    return outcome.proposal.proposalId
  }
  const tryPropose = (kind: string, payload: unknown) => service.createProposal({ kind, payload, roomId: room.id, proposedFor: { userId: officer.id, displayName: officer.displayName } }, deps)
  const apply = (id: string, selectedRows?: string[]) => service.applyProposal(id, me, { selectedRows }, deps)
  const auditFor = (proposalId: string, entityType: string) => prisma.auditLog.count({ where: { entityType, metadata: { path: ["proposalId"], equals: proposalId } } })
  const attach = async (filename: string, contentType: string, kind: "JSON" | "CSV", body: string) => {
    const id = randomUUID()
    const bytes = Buffer.from(body)
    const storagePath = `rooms/${room.id}/${id}/${filename}`
    await store.put(storagePath, bytes, contentType)
    await prisma.jackFile.create({
      data: { id, roomId: room.id, uploadedById: officer.id, filename, contentType, sizeBytes: bytes.length, storagePath, sha256: createHash("sha256").update(bytes).digest("hex"), kind, status: "READY", text: body, textStatus: "ok" },
    })
    return id
  }

  try {
    // Two members who get no email, whatever a notification asks
    const member = (name: string) =>
      prisma.user.create({
        data: {
          email: `${tag}-${name}@example.com`,
          handle: `${tag}-${name}`,
          displayName: `${name[0].toUpperCase()}${name.slice(1)} ${tag}`,
          marketingOptIn: false,
          notificationPrefs: { create: { emailRegistration: false, emailWaitlistPromotion: false } },
        },
      })
    const ana = await member("ana")
    const ben = await member("ben")
    made.users.push(ana.id, ben.id)

    // ---- event.update: publish a draft and raise its capacity (Ben moves off the waitlist) ----
    const start = new Date(Date.now() + 10 * 86_400_000)
    start.setUTCSeconds(0, 0)
    const event = await prisma.event.create({
      data: { title: `Check ${tag}`, slug: `check-${tag}`, timezone: "America/Chicago", startsAtUtc: start, endsAtUtc: new Date(start.getTime() + 2 * 3_600_000), status: "DRAFT", registrationEnabled: true, registrationMax: 1, registrationWaitlistEnabled: true, waitlistAutoPromote: true },
    })
    made.event = event.id
    await prisma.eventRegistration.create({ data: { eventId: event.id, userId: ana.id, status: "REGISTERED" } })
    await prisma.eventRegistration.create({ data: { eventId: event.id, userId: ben.id, status: "WAITLISTED", waitlistOrder: 1 } })

    const publish = await propose("event.update", { eventId: event.id, status: "PUBLISHED", capacity: 2 })
    const published = await apply(publish)
    const eventAfter = await prisma.event.findUniqueOrThrow({ where: { id: event.id } })
    check("event.update applies: published now, with the new capacity", published.ok && eventAfter.status === "PUBLISHED" && Boolean(eventAfter.publishedAt) && eventAfter.registrationMax === 2, JSON.stringify(published))
    const benReg = await prisma.eventRegistration.findUniqueOrThrow({ where: { eventId_userId: { eventId: event.id, userId: ben.id } } })
    check("raising capacity moved the waitlisted member up, as the registration card does", benReg.status === "REGISTERED", benReg.status)
    check("each part's audit entry names the proposal", (await auditFor(publish, "EVENT")) === 2, `${await auditFor(publish, "EVENT")} entries`)

    const rename = await propose("event.update", { eventId: event.id, title: `Check ${tag} renamed` })
    await prisma.event.update({ where: { id: event.id }, data: { title: `Check ${tag} edited elsewhere` } })
    const renamed = await apply(rename)
    check("event.update goes stale when its field was edited meanwhile", !renamed.ok && renamed.proposal?.status === "STALE", JSON.stringify(renamed))

    // ---- news.create and news.update ----
    const refused = await tryPropose("news.create", { title: `Check ${tag}`, bodyMd: "Hi <b>there</b>" })
    check("news.create refuses HTML, with a fixable message", !refused.ok && /must be plain Markdown/.test(refused.error), JSON.stringify(refused))
    const draft = await propose("news.create", { title: `Check ${tag}`, bodyMd: "Hello **there**.\n\n- one\n- two", tags: [`${tag} tag`] })
    const drafted = await apply(draft)
    const post = await prisma.post.findFirst({ where: { slug: { startsWith: `check-${tag}` } } })
    if (post) made.posts.push(post.id)
    made.tagSlugs.push(`${tag}-tag`)
    check("news.create saves a draft by the officer who asked", drafted.ok && Boolean(post) && post!.publishedAt === null && post!.authorId === officer.id, JSON.stringify(drafted))
    const detail = await service.getProposalDetail(draft, officer.id, deps)
    check("the card gets the rendered preview", detail?.preview?.blocks.length === 2 && detail.preview.title === `Check ${tag}`, JSON.stringify(detail?.preview))
    if (post) {
      const edit = await propose("news.update", { postId: post.id, edits: [{ find: "there", replace: "everyone" }], publish: "now" })
      const edited = await apply(edit)
      const postAfter = await prisma.post.findUniqueOrThrow({ where: { id: post.id } })
      const tags = await prisma.entityTag.count({ where: { entityType: "post", entityId: post.id } })
      check("news.update edits the text, publishes it and keeps its tag", edited.ok && postAfter.bodyMd.includes("everyone") && Boolean(postAfter.publishedAt) && tags === 1, JSON.stringify(edited))
    }

    // ---- notification.send: in the bell, to the one member left ticked ----
    const notify = await propose("notification.send", { audience: { type: "members", handles: [ana.handle, ben.handle] }, channels: ["in_app"], title: `Check ${tag}`, body: "Just checking." })
    const sent = await apply(notify, [ana.id])
    const rows = await prisma.notification.findMany({ where: { metadata: { path: ["proposalId"], equals: notify } }, select: { userId: true, channel: true, status: true } })
    check("notification.send sends only to the ticked member, with the proposal on the row", sent.ok && rows.length === 1 && rows[0].userId === ana.id && rows[0].status === "SENT", JSON.stringify(rows))
    check("one audit entry for the send", (await auditFor(notify, "NOTIFICATION")) === 1)

    // ---- staleness from what the card counted: someone joins the audience, the waitlist grows ----
    const cy = await member("cy")
    const dee = await member("dee")
    made.users.push(cy.id, dee.id)
    const toRegistered = await propose("notification.send", { audience: { type: "event", eventId: event.id }, channels: ["in_app"], title: `Check ${tag} registered`, body: "Just checking." })
    await prisma.eventRegistration.create({ data: { eventId: event.id, userId: cy.id, status: "REGISTERED" } })
    const late = await apply(toRegistered)
    const lateRows = await prisma.notification.count({ where: { metadata: { path: ["proposalId"], equals: toRegistered } } })
    check("notification.send goes stale when someone registered for its event since, and sends nothing", !late.ok && late.proposal?.status === "STALE" && /1 person joined/.test(late.error) && lateRows === 0, JSON.stringify(late))

    await prisma.eventRegistration.create({ data: { eventId: event.id, userId: dee.id, status: "WAITLISTED", waitlistOrder: 2 } })
    const roomier = await propose("event.update", { eventId: event.id, capacity: 10 })
    await prisma.eventRegistration.update({ where: { eventId_userId: { eventId: event.id, userId: cy.id } }, data: { status: "WAITLISTED", waitlistOrder: 3 } })
    const grown = await apply(roomier)
    const waiting = await prisma.eventRegistration.count({ where: { eventId: event.id, status: "WAITLISTED" } })
    const capacity = (await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).registrationMax
    check(
      "event.update goes stale when more would move off the waitlist than the card says, and changes nothing",
      !grown.ok && grown.proposal?.status === "STALE" && /move 2 people off the waitlist/.test(grown.error) && waiting === 2 && capacity === 2,
      JSON.stringify({ grown, waiting, capacity }),
    )

    // ---- attendance.checkin ----
    const checkin = await propose("attendance.checkin", { eventId: event.id, names: [ana.displayName, `@${ben.handle}`, "Nobody Here At All"] })
    const checkinRow = await prisma.jackProposal.findUniqueOrThrow({ where: { id: checkin } })
    const view = checkinRow.view as { rows?: { id: string; status?: string }[] }
    check("attendance.checkin matches a name and a handle, and lists the stranger", view.rows?.map((r) => r.status).join(",") === "matched,matched,unmatched", JSON.stringify(view.rows))
    const checked = await apply(checkin, view.rows?.filter((r) => r.status === "matched").map((r) => r.id))
    const attendance = await prisma.eventAttendance.findMany({ where: { eventId: event.id }, select: { userId: true, method: true, checkedInByUserId: true } })
    check(
      "attendance.checkin records manual check-ins by the applying officer",
      checked.ok && attendance.length === 2 && attendance.every((a) => a.method === "MANUAL" && a.checkedInByUserId === officer.id),
      JSON.stringify({ checked, attendance }),
    )
    check("each check-in's audit entry names the proposal", (await auditFor(checkin, "EVENT_ATTENDANCE")) === 2)

    // ---- results.import from a room file ----
    const guids = [`${tag}_G1`, `${tag}_G2`]
    made.guids.push(...guids)
    const results = JSON.stringify({
      TrackName: "spa",
      Type: "RACE",
      Date: start.toISOString(),
      Cars: guids.map((guid, i) => ({ CarId: i, Driver: { Guid: guid, Name: `Driver ${i + 1}` }, Model: "bmw_m4_gt3" })),
      Result: guids.map((guid, i) => ({ DriverGuid: guid, DriverName: `Driver ${i + 1}`, CarId: i, CarModel: "bmw_m4_gt3", BestLap: 140_000 + i, TotalTime: 1_400_000 + i, LapCount: 2 })),
      Laps: guids.flatMap((guid, i) => [1, 2].map((n) => ({ DriverGuid: guid, CarId: i, LapTime: 140_000 + n, Cuts: 0, Timestamp: n }))),
      Events: [],
    })
    const resultsFile = await attach("check-results.json", "application/json", "JSON", results)
    const importResults = await propose("results.import", { fileId: resultsFile, eventId: event.id, sessionLabel: "RACE" })
    const imported = await apply(importResults)
    const upload = await prisma.rawResultUpload.findFirst({ where: { filename: "check-results.json", eventId: event.id }, include: { ingestedSessions: { include: { _count: { select: { results: true, laps: true } } } } } })
    if (upload) made.uploads.push(upload.id)
    check(
      "results.import uploads, parses, links and ingests the file",
      imported.ok && upload?.status === "INGESTED" && upload.ingestedSessions.length === 1 && upload.ingestedSessions[0]._count.results === 2 && upload.ingestedSessions[0]._count.laps === 4,
      JSON.stringify(imported),
    )
    const again = await tryPropose("results.import", { fileId: resultsFile, eventId: event.id, sessionLabel: "RACE" })
    check("the same file can't be imported twice", !again.ok && /already imported/.test(again.error), JSON.stringify(again))
    check("each step's audit entry names the proposal", (await auditFor(importResults, "RESULT_UPLOAD")) === 4, `${await auditFor(importResults, "RESULT_UPLOAD")} entries`)

    // ---- import.rows into LSC entry forms (a throwaway season, so the open one isn't touched) ----
    let league = await prisma.league.findUnique({ where: { slug: "lone-star-cup" } })
    if (!league) {
      league = await prisma.league.create({ data: { name: "Lone Star Cup", slug: "lone-star-cup" } })
      made.league = league.id
    }
    const season = await prisma.season.create({ data: { leagueId: league.id, name: `Check ${tag}`, slug: `check-${tag}`, year: 2000, endAt: new Date("2000-12-31T00:00:00Z") } })
    made.seasons.push(season.id)
    const csv = ["Email,Discord,Gear,Commit", `${ana.email},ana_d,Wheel and pedals,Yes`, `${ana.email.toUpperCase()},ana_again,Wheel,Yes`, `nobody-${tag}@example.com,x,Wheel,No`].join("\n")
    const sheet = await attach("signups.csv", "text/csv", "CSV", csv)
    const importRows = await propose("import.rows", { fileId: sheet, target: "lsc_application", columnMap: { email: "Email", discord: "Discord", equipment: "Gear", canCommit: "Commit" }, values: { season: season.slug } })
    const importRow = await prisma.jackProposal.findUniqueOrThrow({ where: { id: importRows } })
    const importView = importRow.view as { rows?: { id: string; status?: string }[] }
    check("import.rows checks each row: ready, a repeat, and one without an account", importView.rows?.map((r) => r.status).join(",") === "matched,ambiguous,unmatched", JSON.stringify(importView.rows))
    const added = await apply(importRows)
    const forms = await prisma.leagueApplication.findMany({ where: { seasonId: season.id }, select: { userId: true, source: true, createdById: true, discordUsername: true, equipment: true, canCommit: true } })
    check(
      "the ready row becomes an entry form, added by the applying officer",
      added.ok && forms.length === 1 && forms[0].userId === ana.id && forms[0].source === "ADMIN" && forms[0].createdById === officer.id && forms[0].discordUsername === "ana_d" && forms[0].canCommit,
      JSON.stringify({ added, forms }),
    )
    check("its audit entry names the proposal", (await auditFor(importRows, "LeagueApplication")) === 1)

    // Every proposal ends with a room note; none were left applying
    const states = await prisma.jackProposal.groupBy({ by: ["status"], where: { roomId: room.id }, _count: { _all: true } })
    check("no proposal is left applying", !states.some((s) => s.status === "APPLYING"), JSON.stringify(states))
  } finally {
    // Undo everything, in an order the foreign keys allow
    await prisma.rawResultUpload.deleteMany({ where: { id: { in: made.uploads } } })
    await prisma.driverIdentity.deleteMany({ where: { driverGuid: { in: made.guids } } })
    await prisma.leagueApplication.deleteMany({ where: { seasonId: { in: made.seasons } } })
    await prisma.season.deleteMany({ where: { id: { in: made.seasons } } })
    if (made.league) await prisma.league.delete({ where: { id: made.league } })
    await prisma.entityTag.deleteMany({ where: { entityType: "post", entityId: { in: made.posts } } })
    await prisma.tag.deleteMany({ where: { slug: { in: made.tagSlugs } } })
    await prisma.post.deleteMany({ where: { id: { in: made.posts } } })
    if (made.event) await prisma.event.delete({ where: { id: made.event } }).catch(() => {})
    await prisma.auditLog.deleteMany({ where: { metadata: { path: ["roomId"], equals: room.id } } })
    await prisma.jackRoom.delete({ where: { id: room.id } })
    await prisma.user.deleteMany({ where: { id: { in: made.users } } })
    const left = await prisma.auditLog.count({ where: { metadata: { path: ["roomId"], equals: room.id } } })
    check("cleaned up: no audit entries from the room are left", left === 0, `${left} left`)
    await prisma.$disconnect()
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
