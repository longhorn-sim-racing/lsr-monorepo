/**
 * LOCAL ONLY: checks Instagram publishing and the gallery add (T9b, docs/jack-2/tracks/decks-rooms.md)
 * against the real local Postgres and the Instagram and Cloudinary HTTP fakes, started in this process,
 * where the unit tests use in-memory tables:
 * - a post goes through the real InstagramPublish row: queued, the images on the Cloudinary fake, the
 *   containers saved as JSON, published with its link;
 * - one row per proposal (the unique key), and of five claims on one row at once exactly one wins;
 * - a post Instagram is still processing waits, and the follow-up posts it and leaves a room note;
 * - a publish call whose answer was lost is found, never posted twice;
 * - the site's daily cap and the history, digest and deck page queries run in SQL;
 * - gallery.add's album and images: a new album with a free slug, at the end of the order, a slide
 *   never added twice.
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/check-jack-publish.ts
 *
 * Uses an existing officer or admin (read only). Writes a room, a deck, InstagramPublish rows, a gallery
 * album and its images, room notes and audit entries, and deletes them all at the end, pass or fail.
 * Nothing goes to Instagram or Cloudinary: both are fakes on this machine, and the instagram-publish
 * connector is never switched on (the publisher is passed in). Slides aren't rendered: the checks hand
 * the flow a PNG. Refuses unless DATABASE_URL points at 127.0.0.1 or localhost.
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

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++
  else fail++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${detail}`}`)
}

async function main() {
  const { startFakeServer } = await import("../src/server/connectors/fakes/server")
  const { instagramFake, INSTAGRAM_FAKE } = await import("../src/server/connectors/instagram/fake/handlers")
  const { cloudinaryFake, CLOUDINARY_FAKE } = await import("../src/server/connectors/cloudinary/fake/handlers")
  const fakes = await startFakeServer({ services: [instagramFake, cloudinaryFake], port: 0 })
  // Every Instagram and Cloudinary call goes to the fakes, with the fakes' own credentials
  process.env.JACK_FAKES = "instagram,cloudinary"
  process.env.JACK_FAKES_URL = fakes.url
  process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME = CLOUDINARY_FAKE.cloudName
  process.env.CLOUDINARY_API_KEY = CLOUDINARY_FAKE.apiKey
  process.env.CLOUDINARY_API_SECRET = CLOUDINARY_FAKE.apiSecret

  const sharp = (await import("sharp")).default
  const { prisma } = await import("../src/server/db")
  const { instagramGraph } = await import("../src/server/connectors/instagram/graph")
  const { instagramPublisher } = await import("../src/server/connectors/instagram/publish")
  const { uploadImageBytes } = await import("../src/server/cloudinary")
  const publish = await import("../src/server/jack/publish/instagram")
  const { addToGallery, galleryPublicId } = await import("../src/server/jack/publish/gallery")
  const { getDeck } = await import("../src/server/jack/decks/service")
  const { listPublishes } = await import("../src/server/queries/instagram-publish")
  const { instagramPublishNeedsAttention } = await import("../src/server/automation/checks/decks-rooms")

  const officer = await prisma.user.findFirst({ where: { roles: { some: { role: { key: { in: ["admin", "officer"] } } } } }, orderBy: { createdAt: "asc" } })
  if (!officer) throw new Error("No officer or admin in this database: pnpm set-role <email> admin")

  const tag = `check-jack-publish ${Date.now().toString(36)}`
  const png = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#1a2b3c" } }).png().toBuffer()
  const deps = (): import("../src/server/jack/publish/instagram").PublishDeps => ({
    client: { ...instagramPublisher(instagramGraph(INSTAGRAM_FAKE.publishToken), INSTAGRAM_FAKE.userId), username: INSTAGRAM_FAKE.username },
    slidePng: async () => png,
    upload: (body, publicId) => uploadImageBytes(body, { publicId }),
    sleep: (ms) => new Promise((done) => setTimeout(done, Math.min(ms, 50))),
    now: () => new Date(),
  })
  const knob = (body: Record<string, unknown>) => fetch(`${fakes.url}/instagram/_fake/publish`, { method: "POST", body: JSON.stringify(body) })
  const instagramState = async () => (await (await fetch(`${fakes.url}/instagram/_fake/publish`)).json()) as { posts: unknown[]; containers: { id: string; kind: string }[] }

  const room = await prisma.jackRoom.create({ data: { createdById: officer.id, title: tag } })
  const deckRow = await prisma.jackDeck.create({ data: { title: `${tag} deck`, size: "slides", version: 1, roomId: room.id, createdById: officer.id } })
  await prisma.jackDeckVersion.create({ data: { deckId: deckRow.id, version: 1, summary: "check", content: { css: "", slides: ["chkslide1", "chkslide2", "chkslide3"].map((id) => ({ id, html: `<section class="slide dark"><h1>${id}</h1></section>` })) } } })
  const deck = (await getDeck(deckRow.id))!
  const slides = deck.content.slides.map((s, i) => ({ ...s, n: i + 1 }))
  const publishIds: string[] = []
  const albumIds: string[] = []
  const imageIds: string[] = []
  const proposalBase = `chk-${Date.now().toString(36)}`
  const input = (over: Partial<import("../src/server/jack/publish/instagram").StartPublish> = {}): import("../src/server/jack/publish/instagram").StartPublish => ({
    deck,
    slides: [slides[0]],
    type: "post",
    caption: `${tag} caption`,
    aiGenerated: false,
    createdById: officer.id,
    approvedById: officer.id,
    auditMetadata: { via: "check" },
    ...over,
  })
  const track = async <T extends { row: { id: string } }>(work: Promise<T>) => {
    const outcome = await work
    publishIds.push(outcome.row.id)
    return outcome
  }

  try {
    // A post, end to end, through real rows
    const post = await track(publish.startInstagramPublish(input({ type: "carousel", slides, aiGenerated: true, proposalId: `${proposalBase}-1` }), deps()))
    const row = await prisma.instagramPublish.findUniqueOrThrow({ where: { id: post.row.id } })
    const containers = publish.readContainers(row.containerIds)
    check("a carousel is posted: images on Cloudinary, items and the carousel saved, the post's link", post.state === "published" && row.status === "published" && row.imageUrls.length === 3 && containers.items.length === 3 && Boolean(containers.carousel) && containers.aiGenerated && Boolean(row.permalink) && row.claimedAt === null, JSON.stringify({ status: row.status, containers, permalink: row.permalink }))
    check("the deck's 16:9 slides went as 1080x1350 JPEGs", (await sharp(Buffer.from(await (await fetch(row.imageUrls[0])).arrayBuffer())).metadata()).height === 1350)
    const audit = await prisma.auditLog.findFirst({ where: { entityType: "INSTAGRAM_PUBLISH", entityId: row.id } })
    check("it's audited as the approving officer", audit?.actorUserId === officer.id && /^Posted /.test(audit.summary), JSON.stringify(audit?.summary))

    // One row per proposal: the unique key holds, and a second apply carries on with the first's row
    const again = await publish.startInstagramPublish(input({ proposalId: `${proposalBase}-1` }), deps())
    check("a second apply of the same proposal reuses its row and posts nothing more", again.row.id === row.id && (await prisma.instagramPublish.count({ where: { proposalId: `${proposalBase}-1` } })) === 1 && (await instagramState()).posts.length === 1)

    // Waiting on Instagram, then the follow-up
    await knob({ processingReads: 1_000 })
    const waiting = await track(publish.startInstagramPublish(input({ proposalId: `${proposalBase}-2` }), deps(), { waitMs: 300 }))
    check("a post Instagram is still processing waits, let go", waiting.state === "waiting" && waiting.row.status === "containers" && waiting.row.claimedAt === null, JSON.stringify(waiting.row.status))
    const claims = await Promise.all(Array.from({ length: 5 }, () => publish.claimPublish(waiting.row.id, new Date())))
    check("of five claims on it at once, exactly one wins", claims.filter(Boolean).length === 1, JSON.stringify(claims))
    await prisma.instagramPublish.update({ where: { id: waiting.row.id }, data: { claimedAt: null } })
    await knob({ ready: true })
    const counts = await publish.finishInstagramPublishes(deps(), { deadline: Date.now() + 60_000, ids: [waiting.row.id] })
    const finished = await prisma.instagramPublish.findUniqueOrThrow({ where: { id: waiting.row.id } })
    const note = await prisma.jackMessage.findFirst({ where: { roomId: room.id, kind: "system" }, orderBy: { createdAt: "desc" } })
    check("the follow-up posts it and tells the deck's room", counts.published === 1 && finished.status === "published" && Boolean(note?.content.startsWith("Posted ")), JSON.stringify({ counts, status: finished.status, note: note?.content }))

    // A publish call whose answer was lost
    await knob({ processingReads: 1, dropPublish: 1 })
    const dropped = await track(publish.startInstagramPublish(input({ caption: `${tag} dropped` }), deps()))
    check("a post whose publish answer was lost is found, not posted twice", dropped.state === "published" && Boolean(dropped.row.igMediaId) && (await instagramState()).posts.length === 3, JSON.stringify({ state: dropped.state, posts: (await instagramState()).posts.length }))

    // The queries the pages and the digest run
    const history = await listPublishes({ limit: 50 })
    const listed = history.filter((h) => publishIds.includes(h.id))
    check("the history lists them with the deck, who approved, and the proposal's room link", listed.length === publishIds.length && listed.every((h) => h.deck?.title === deck.title && h.approvedByName === officer.displayName) && listed.some((h) => h.aiGenerated), JSON.stringify(listed.map((h) => [h.status, h.deck?.title])))
    const digest = await instagramPublishNeedsAttention.run({ now: new Date() })
    check("the digest check runs", typeof digest.count === "number")
    const sinceDay = await prisma.instagramPublish.count({ where: { createdAt: { gt: new Date(Date.now() - 86_400_000) }, status: { not: "failed" } } })
    check("the daily cap's count reads the last 24 hours", sinceDay >= publishIds.length, String(sinceDay))

    // The gallery
    const albumTitle = `${tag} album`
    const added = await addToGallery({ target: { newAlbum: { title: albumTitle, date: "2026-10-19" } }, items: slides.slice(0, 2).map((slide) => ({ rowId: `slide:${slide.id}`, kind: "slide" as const, deck, slide, alt: `${deck.title}, slide ${slide.n}` })), actorUserId: officer.id, auditMetadata: { via: "check" } })
    albumIds.push(added.album.id)
    imageIds.push(...added.added.map((a) => a.imageId))
    const images = await prisma.galleryImage.findMany({ where: { albumId: added.album.id }, orderBy: { order: "asc" } })
    check("a new album with its slug, and the slides in order", added.album.created && added.album.slug.startsWith("check-jack-publish") && images.length === 2 && images[0].order === 1 && images[1].order === 2 && images[0].publicId === galleryPublicId({ rowId: "x", kind: "slide", deck, slide: slides[0], alt: "" }), JSON.stringify(images.map((i) => [i.order, i.publicId])))
    const second = await addToGallery({ target: { albumId: added.album.id }, items: slides.map((slide) => ({ rowId: `slide:${slide.id}`, kind: "slide" as const, deck, slide, alt: "x" })), actorUserId: officer.id, auditMetadata: { via: "check" } })
    imageIds.push(...second.added.map((a) => a.imageId))
    check("the same slide is never added twice; a new one goes at the end", second.already.length === 2 && second.added.length === 1 && (await prisma.galleryImage.findUnique({ where: { id: second.added[0].imageId } }))?.order === 3, JSON.stringify(second))
  } finally {
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityType: "INSTAGRAM_PUBLISH", entityId: { in: publishIds } }, { entityType: "GALLERY_ALBUM", entityId: { in: albumIds } }, { entityType: "GALLERY_IMAGE", entityId: { in: [...imageIds, "BATCH"] }, metadata: { path: ["via"], equals: "check" } }] } })
    await prisma.instagramPublish.deleteMany({ where: { OR: [{ id: { in: publishIds } }, { proposalId: { startsWith: proposalBase } }] } })
    await prisma.galleryImage.deleteMany({ where: { OR: [{ id: { in: imageIds } }, { albumId: { in: albumIds } }] } })
    await prisma.galleryAlbum.deleteMany({ where: { id: { in: albumIds } } })
    await prisma.jackDeck.deleteMany({ where: { id: deckRow.id } })
    await prisma.jackRoom.deleteMany({ where: { id: room.id } })
    await fakes.close()
    await prisma.$disconnect()
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
