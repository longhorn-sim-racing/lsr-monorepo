/**
 * LOCAL ONLY: puts one card of each of the changes track's proposals in a Jack room without calling
 * Claude (#188), to look at them in the browser: event.update, news.create (with its rendered preview),
 * notification.send, attendance.checkin, results.import and import.rows. An officer's message carries a
 * results file and a sign-up sheet; a scripted fake Claude answers it through the real reply loop and
 * calls the propose_* tools exactly as Jack would. Nothing is spent.
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/try-jack-changes.ts                     # a new room
 *   pnpm --filter @lsr/platform exec tsx scripts/try-jack-changes.ts --room=<id>         # an existing room
 *   pnpm --filter @lsr/platform exec tsx scripts/try-jack-changes.ts --as=<email|handle> # asked by this officer
 *   pnpm --filter @lsr/platform exec tsx scripts/try-jack-changes.ts --clean             # delete the events and rooms it made
 *
 * It makes a draft event ("Changes check …") for the event and check-in cards, and leaves it and the room
 * for you to look at. Applying a card changes your local database the way the admin pages would (a news
 * post, notifications in the officers' bells, check-ins, race results, entry forms); undo those on their
 * pages, or --clean for the events and rooms. Files go to the local file store (JACK_FILE_STORE, or
 * .jack-renders/). Refuses unless DATABASE_URL points at 127.0.0.1 or localhost. Without
 * NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY it can't broadcast, so reload the room.
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

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const EVENT_TITLE = "Changes check"
const ROOM_TITLE = "Changes check"

const POST = `## Welcome to the season

Races are **Saturdays at 7 PM**. Bring a wheel if you have one; the lounge has a few.

1. Sign up on [the events page](/events)
2. Read [the rules](/lone-star-cup/rules)
3. Join the [Discord](https://discord.com)

| Round | Track |
|---|---|
| 1 | Spa |
| 2 | Monza |

> See you on track.

Use \`/register\` in Discord to get your role.`

function resultsFile(): string {
  const drivers = ["A", "B", "C"].map((x, i) => ({ guid: `TRY_GUID_${x}`, name: `Try Driver ${x}`, car: i }))
  return JSON.stringify({
    TrackName: "spa",
    Type: "RACE",
    Date: new Date().toISOString(),
    Cars: drivers.map((d) => ({ CarId: d.car, Driver: { Guid: d.guid, Name: d.name }, Model: "bmw_m4_gt3" })),
    Result: drivers.map((d, i) => ({ DriverGuid: d.guid, DriverName: d.name, CarId: d.car, CarModel: "bmw_m4_gt3", BestLap: 139_000 + i * 700, TotalTime: 1_400_000 + i * 3_000, LapCount: 2 })),
    Laps: drivers.flatMap((d, i) => [1, 2].map((n) => ({ DriverGuid: d.guid, CarId: d.car, LapTime: 140_000 + i * 700 + n, Cuts: 0, Timestamp: n }))),
    Events: [],
  })
}

async function main() {
  const { prisma } = await import("../src/server/db")

  if (process.argv.includes("--clean")) {
    const { jackFileStore } = await import("../src/server/jack/decks/storage")
    const files = await prisma.jackFile.findMany({ where: { room: { title: ROOM_TITLE } }, select: { storagePath: true } })
    await jackFileStore().delete(files.map((f) => f.storagePath))
    const rooms = await prisma.jackRoom.deleteMany({ where: { title: ROOM_TITLE } })
    const uploads = await prisma.rawResultUpload.deleteMany({ where: { event: { title: { startsWith: EVENT_TITLE } } } })
    const events = await prisma.event.deleteMany({ where: { title: { startsWith: EVENT_TITLE }, slug: { startsWith: "changes-check-" } } })
    await prisma.driverIdentity.deleteMany({ where: { driverGuid: { startsWith: "TRY_GUID_" } } })
    console.log(`Deleted ${rooms.count} rooms, ${events.count} events and ${uploads.count} result uploads.`)
    await prisma.$disconnect()
    return
  }

  const { postOfficerMessage } = await import("../src/server/jack/rooms")
  const { defaultReplyDeps } = await import("../src/server/jack/reply-loop")
  const { fakeClaude } = await import("../src/server/jack/fake-claude")
  const { jackFileStore } = await import("../src/server/jack/decks/storage")
  const { getOpenLeagueSeason } = await import("../src/server/services/league-entry.service")

  const as = arg("as")
  const officer = await prisma.user.findFirst({
    where: { roles: { some: { role: { key: { in: ["admin", "officer"] } } } }, ...(as ? { OR: [{ email: as }, { handle: as }] } : {}) },
    orderBy: { createdAt: "asc" },
  })
  if (!officer) throw new Error(as ? `No officer or admin "${as}".` : "No officer or admin in this database: pnpm set-role <email> admin")

  const stamp = Date.now().toString(36)
  const start = new Date(Date.now() + 7 * 86_400_000)
  start.setUTCMinutes(0, 0, 0)
  const event = await prisma.event.create({
    data: { title: `${EVENT_TITLE} ${stamp}`, slug: `changes-check-${stamp}`, timezone: "America/Chicago", startsAtUtc: start, endsAtUtc: new Date(start.getTime() + 2 * 3_600_000), status: "DRAFT", registrationEnabled: true, registrationMax: 20 },
  })
  const roomId = arg("room") ?? (await prisma.jackRoom.create({ data: { createdById: officer.id, title: ROOM_TITLE } })).id

  // The officer's two attachments, stored and READY as registration leaves them
  const store = jackFileStore()
  const attach = async (filename: string, contentType: string, kind: "JSON" | "CSV", body: string) => {
    const id = randomUUID()
    const bytes = Buffer.from(body)
    const storagePath = `rooms/${roomId}/${id}/${filename}`
    await store.put(storagePath, bytes, contentType)
    await prisma.jackFile.create({
      data: { id, roomId, uploadedById: officer.id, filename, contentType, sizeBytes: bytes.length, storagePath, sha256: createHash("sha256").update(bytes).digest("hex"), kind, status: "READY", text: body, textStatus: "ok" },
    })
    return id
  }
  const results = await attach("round-results.json", "application/json", "JSON", resultsFile())
  // A member without an entry form for the open LSC season makes a row that's ready; the second row has no account
  const league = await prisma.league.findUnique({ where: { slug: "lone-star-cup" }, select: { id: true } })
  const open = league ? await getOpenLeagueSeason(league.id) : null
  const free = open ? await prisma.user.findFirst({ where: { status: { not: "deleted" }, leagueApplications: { none: { seasonId: open.id } } }, orderBy: { createdAt: "asc" }, select: { email: true } }) : null
  const sheet = free ? await attach("lsc-signups.csv", "text/csv", "CSV", ["Email,Discord,Equipment,Commit", `${free.email},try_driver,Wheel and pedals,Yes`, "nobody@example.com,someone,Controller,No"].join("\n")) : null
  if (!sheet) console.log("No open LSC season with a member who hasn't entered it, so there's no import.rows card.")

  const fake = fakeClaude([
    {
      text: "Here are the cards.",
      tools: [
        { name: "propose_change", input: { proposal: { kind: "event.update", eventId: event.id, status: "PUBLISHED", capacity: 30 } } },
        { name: "propose_content", input: { proposal: { kind: "news.create", title: "Welcome to LSC Season 3", excerpt: "How the season works.", bodyMd: POST, tags: ["LSC"] } } },
        { name: "propose_message", input: { proposal: { kind: "notification.send", audience: { type: "officers" }, channels: ["in_app"], title: "Board meeting Sunday", body: "Reminder: the board meeting is Sunday at 4 PM.\n\nAgenda in the room.", link: "/admin/jack" } } },
        { name: "propose_import", input: { proposal: { kind: "attendance.checkin", eventId: event.id, names: [officer.displayName, "Nobody Example"] } } },
        { name: "propose_import", input: { proposal: { kind: "results.import", fileId: results, eventId: event.id, sessionLabel: "RACE" } } },
        ...(sheet ? [{ name: "propose_import", input: { proposal: { kind: "import.rows", fileId: sheet, target: "lsc_application", columnMap: { email: "Email", discord: "Discord", equipment: "Equipment", canCommit: "Commit" } } } }] : []),
      ],
    },
    { text: "Each card above shows what applying it does. Nothing changes until an officer presses Apply." },
  ])
  const replyDeps = { ...defaultReplyDeps, getClient: () => fake.client, budget: async () => ({ month: "check", spentUsd: 0, budgetUsd: 1 }) }

  // Outside a request, the reply runs inline: this returns once it's done
  await postOfficerMessage(roomId, officer.id, `Publish ${event.title}, draft a welcome post, remind the officers about Sunday, check me in, import these results and add these sign-ups.`, { replyDeps, fileIds: sheet ? [results, sheet] : [results] })

  const proposals = await prisma.jackProposal.findMany({ where: { roomId }, orderBy: { createdAt: "asc" }, select: { kind: true, title: true, status: true } })
  for (const p of proposals) console.log(`  ${p.kind.padEnd(19)} ${p.status.padEnd(8)} ${p.title}`)
  const wanted = sheet ? 6 : 5
  if (proposals.length < wanted) {
    const reply = await prisma.jackMessage.findFirst({ where: { roomId, kind: "assistant" }, orderBy: { createdAt: "desc" } })
    console.log(`Only ${proposals.length} of ${wanted} proposals were made. The reply's tools: ${JSON.stringify(reply?.toolCalls)}`)
  }
  console.log(`Open the room: http://localhost:3000/admin/jack/${roomId}`)
  console.log(`All proposals: http://localhost:3000/admin/jack/proposals`)
  await prisma.$disconnect()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
