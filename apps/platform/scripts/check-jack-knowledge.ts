/**
 * Checks the knowledge service (src/server/jack/knowledge) against the LOCAL database (#188, design §9):
 * the parts unit tests can't, because they live in Postgres. The duplicate check's lexeme counts (the
 * english parser, the search index row the trigger writes), the page's full-text search, versions under
 * the row lock (edits and marking reviewed), the "not reviewed" and stale views, and that a hard delete
 * takes the versions and the search index row with it and clears Jack's notes and tool calls in a room.
 *
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres pnpm --filter @lsr/platform exec tsx scripts/check-jack-knowledge.ts
 *
 * Refuses to run unless DATABASE_URL points at this machine. Writes only entries tagged with this run's
 * marker (and their audit entries) and one room of its own, and deletes them all at the end, pass or fail.
 */
import { randomBytes, randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { DELETED_KNOWLEDGE_NOTE } from "../src/lib/jack/knowledge"
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
const problem = localDatabaseProblem("DATABASE_URL", process.env.DATABASE_URL)
if (problem) {
  console.error(`Refusing to run: ${problem}`)
  process.exit(1)
}
// db.ts logs every query unless NODE_ENV is production; keep the run readable
;(process.env as Record<string, string | undefined>).NODE_ENV ??= "production"

const MARK = `chk${randomBytes(4).toString("hex")}`
let failures = 0
function check(ok: boolean, what: string, detail?: unknown) {
  if (ok) console.log(`  ok    ${what}`)
  else {
    failures++
    console.log(`  FAIL  ${what}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`)
  }
}

async function main() {
  const { prisma } = await import("../src/server/db")
  const service = await import("../src/server/jack/knowledge/service")
  const queries = await import("../src/server/jack/knowledge/queries")
  const admin = { userId: null, via: "admin" as const }
  const jack = { userId: null, via: "jack" as const, roomId: `room-${MARK}` }
  const created: string[] = []
  const rooms: string[] = []
  const track = <T extends { ok: boolean }>(result: T) => {
    if (result.ok && "entry" in result) created.push((result as unknown as { entry: { id: string } }).entry.id)
    return result
  }

  try {
    console.log(`Marker ${MARK}\n`)
    console.log("Create and the search index")
    const dues = track(
      await service.createKnowledgeEntry(
        {
          title: `Membership dues this semester ${MARK}`,
          body: `There are no membership dues this semester (the president decided at the start of the semester). Members only pay activity fees, like the Lone Star Cup entry fee. ${MARK}`,
          tags: ["dues", "policy", MARK],
        },
        admin,
      ),
    )
    check(dues.ok, "an officer's entry saves", dues)
    if (!dues.ok) return
    const versions = await prisma.knowledgeEntryVersion.count({ where: { entryId: dues.entry.id } })
    check(versions === 1, "with its first version", versions)
    const indexed = await prisma.jackSearchDoc.count({ where: { source: "knowledge", sourceId: dues.entry.id } })
    check(indexed === 1, "and a search index row (trigger)", indexed)

    console.log("\nDuplicates")
    const sameTitle = await service.createKnowledgeEntry({ title: `Membership dues this semester ${MARK}`, body: "Something else entirely about tabling at events." }, admin)
    check(!sameTitle.ok && sameTitle.reason === "duplicate" && sameTitle.duplicates.some((d) => d.id === dues.entry.id), "the same title is refused, naming the entry", sameTitle)
    const plural = await service.createKnowledgeEntry({ title: `Membership due for this semester ${MARK}`, body: "Short." }, admin)
    check(!plural.ok && plural.reason === "duplicate", "a stemmed variant of the title too (dues → due)", plural)
    const sameText = await service.createKnowledgeEntry(
      { title: `Fees ${MARK}`, body: `No membership dues this semester; the president decided it. Members pay activity fees like the Lone Star Cup entry fee only. ${MARK}` },
      admin,
    )
    check(!sameText.ok && sameText.reason === "duplicate" && sameText.duplicates[0]?.reason === "text", "nearly the same text under another title is refused (text match)", sameText)
    const different = track(
      await service.createKnowledgeEntry({ title: `Brand colors ${MARK}`, body: `Burnt orange #BF5700 and charcoal are the club colors; Kanit for headings, Montserrat for text. ${MARK}`, tags: ["brand", MARK] }, admin),
    )
    check(different.ok, "an unrelated entry saves", different)
    const anyway = track(await service.createKnowledgeEntry({ title: `Membership dues this semester ${MARK}`, body: "Fall semester only." }, admin, { notDuplicateOf: [dues.entry.id] }))
    check(anyway.ok, "a named duplicate saves with notDuplicateOf", anyway)

    console.log("\nVersions and the base check")
    const base = await service.latestKnowledgeVersionId(dues.entry.id)
    const edit = await service.updateKnowledgeEntry(dues.entry.id, { body: `${dues.entry.body} Updated.` }, admin, { baseVersionId: base, markReviewed: true })
    check(edit.ok && edit.changed && edit.versionId !== base, "an edit on the latest version writes a new one", edit.ok ? edit.versionId : edit)
    const stale = await service.updateKnowledgeEntry(dues.entry.id, { body: "Overwrite" }, admin, { baseVersionId: base })
    check(!stale.ok && stale.reason === "conflict" && stale.current.versionId === (edit.ok ? edit.versionId : null), "an edit on an older version is refused with the current one", stale)
    const noBase = await service.updateKnowledgeEntry(dues.entry.id, { body: "Jack without a base" }, jack)
    check(!noBase.ok && noBase.reason === "missing_base", "Jack's edit needs a base version", noBase)
    const reviewed = await prisma.knowledgeEntry.findUniqueOrThrow({ where: { id: dues.entry.id }, select: { reviewedAt: true } })
    check(reviewed.reviewedAt !== null, "marking reviewed on save sets reviewedAt")
    const jackEdit = await service.updateKnowledgeEntry(dues.entry.id, { body: `${dues.entry.body} Jack's change.` }, jack, { baseVersionId: edit.ok ? edit.versionId : null })
    check(jackEdit.ok && jackEdit.entry.reviewedAt === null, "Jack's edit clears the review", jackEdit.ok ? jackEdit.entry.reviewedAt : jackEdit)
    const ordered = await prisma.knowledgeEntryVersion.findMany({ where: { entryId: dues.entry.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { via: true } })
    check(ordered.map((v) => v.via).join(",") === "admin,admin,jack", "versions come back in the order they were written", ordered)
    // Two edits at once: the row lock lets one win; the other sees the moved-on version
    const latest = await service.latestKnowledgeVersionId(dues.entry.id)
    const race = await Promise.all([
      service.updateKnowledgeEntry(dues.entry.id, { title: `Membership dues (race A) ${MARK}` }, admin, { baseVersionId: latest }),
      service.updateKnowledgeEntry(dues.entry.id, { title: `Membership dues (race B) ${MARK}` }, admin, { baseVersionId: latest }),
    ])
    check(race.filter((r) => r.ok).length === 1 && race.some((r) => !r.ok && r.reason === "conflict"), "of two edits on the same version, one wins and one conflicts", race.map((r) => (r.ok ? "ok" : r.reason)))
    const staleReview = await service.markKnowledgeReviewed(dues.entry.id, admin, { baseVersionId: base })
    check(!staleReview.ok && staleReview.reason === "conflict", "marking reviewed on an older version is refused (under the row lock)", staleReview)

    console.log("\nSecrets")
    // Built from pieces so no scanner mistakes it for a real key
    const fakeKey = "sk_" + "live_" + "a1b2c3d4".repeat(4)
    const secret = await service.createKnowledgeEntry({ title: `Stripe access ${MARK}`, body: `The key is ${fakeKey}` }, admin)
    check(!secret.ok && secret.reason === "secret", "a Stripe key is refused", secret)

    console.log("\nSearch and views")
    const byStem = await queries.searchKnowledgeIds(`semesters ${MARK}`)
    check(byStem.includes(dues.entry.id), "full-text search finds the entry by a stemmed word", byStem)
    const byTitle = await queries.searchKnowledgeIds(`Brand col`)
    check(different.ok && byTitle.includes(different.entry.id), "a partial title matches too", byTitle)
    const unreviewed = await prisma.knowledgeEntry.findMany({ where: { AND: [queries.knowledgeWhere("unreviewed"), { tags: { has: MARK } }] }, select: { id: true } })
    check(unreviewed.length === 1 && unreviewed[0].id === dues.entry.id, "the not-reviewed view holds Jack's change only", unreviewed)
    if (different.ok) {
      await prisma.knowledgeEntry.update({ where: { id: different.entry.id }, data: { sourceDate: new Date(Date.now() - 200 * 86_400_000) } })
      const stale = await prisma.knowledgeEntry.findMany({ where: { AND: [queries.knowledgeWhere("stale"), { tags: { has: MARK } }] }, select: { id: true } })
      check(stale.some((s) => s.id === different.entry.id) && !stale.some((s) => s.id === dues.entry.id), "the stale view holds an entry with an old source date", stale)
    }

    console.log("\nThe Knowledge page's reads and the digest checks")
    const page = await queries.listKnowledgeEntries({ q: `semester ${MARK}`, view: "unreviewed" })
    check(page.rows.length === 1 && page.rows[0].id === dues.entry.id && page.rows[0].unreviewed && page.counts.unreviewed >= 1, "a search within the not-reviewed view finds Jack's change", page.rows)
    const all = await queries.listKnowledgeEntries({ view: "active" })
    check(all.rows.some((r) => r.id === dues.entry.id) && all.total === all.counts.active, "the full list pages through the active view", { total: all.total, counts: all.counts })
    const detail = await queries.getKnowledgeEntryDetail(dues.entry.id)
    check(
      // Newest first: the race's winner, Jack's edit, the reviewed edit, the first save
      detail !== null && detail.versions.map((v) => v.via).join(",") === "admin,jack,admin,admin" && detail.latestVersionId === detail.versions[0].id && detail.unreviewed,
      "an entry's page gets its versions newest first",
      detail?.versions.map((v) => v.via),
    )
    const { CHECKS } = await import("../src/server/automation/checks/memory")
    for (const digest of CHECKS) {
      const result = await digest.run({ now: new Date() })
      check(result.count >= 0 && result.items.every((item) => item.href.startsWith("/admin/knowledge/")), `the "${digest.label}" digest check runs`, result)
    }

    console.log("\nArchive and delete")
    const archived = await service.setKnowledgeArchived(dues.entry.id, true, admin)
    const dupAfterArchive = await service.findKnowledgeDuplicates({ title: `Membership dues this semester ${MARK}`, body: "x" }, { exclude: anyway.ok ? [anyway.entry.id] : [] })
    check(archived.ok && archived.changed && !dupAfterArchive.some((d) => d.id === dues.entry.id), "an archived entry no longer counts as a duplicate", dupAfterArchive)
    const removed = await service.deleteKnowledgeEntry(dues.entry.id, admin)
    const left = await Promise.all([
      prisma.knowledgeEntryVersion.count({ where: { entryId: dues.entry.id } }),
      prisma.jackSearchDoc.count({ where: { source: "knowledge", sourceId: dues.entry.id } }),
    ])
    check(removed.ok && left[0] === 0 && left[1] === 0, "a hard delete takes the versions and the search index row", left)

    console.log("\nDelete clears Jack's copies in rooms")
    const room = await prisma.jackRoom.create({ data: { title: `Knowledge check ${MARK}` }, select: { id: true } })
    rooms.push(room.id)
    const word = `zebrafinch${MARK}`
    const noteId = randomUUID()
    const provenance = { roomId: room.id, replyId: null, messageIds: [], askedBy: { userId: null, name: "Check" }, tools: [], at: new Date().toISOString() }
    const saved = track(await service.createKnowledgeEntry({ title: `Private note ${MARK}`, body: `Only ${word} knows this.`, tags: [MARK] }, { ...jack, roomId: room.id }, { provenance, noteId }))
    check(saved.ok, "Jack's save keeps its note's id", saved.ok ? saved.entry.provenance : saved)
    if (saved.ok) {
      const knowledgePart = {
        id: "t1",
        name: "knowledge",
        label: `Saved “${saved.entry.title}” to knowledge`,
        status: "done",
        at: 0,
        input: { action: "save", title: saved.entry.title, body: `Only ${word} knows this.` },
        displays: [{ kind: "links", items: [{ title: saved.entry.title, url: `/admin/knowledge/${saved.entry.id}` }] }],
      }
      const sqlPart = { id: "t2", name: "run_sql", label: "Ran a query (1 row)", status: "done", at: 0, input: { sql: "select 1" }, displays: [] }
      await prisma.jackMessage.create({ data: { id: noteId, roomId: room.id, kind: "system", content: `Saved in knowledge for Check: “${saved.entry.title}”\n\nOnly ${word} knows this.` } })
      const reply = await prisma.jackMessage.create({ data: { roomId: room.id, kind: "assistant", persona: "jack", content: "Saved it.", toolCalls: [knowledgePart, sqlPart] }, select: { id: true } })
      const other = await prisma.jackMessage.create({ data: { roomId: room.id, kind: "assistant", persona: "jack", content: "Something else.", toolCalls: [sqlPart] }, select: { id: true, updatedAt: true } })
      const findsNote = async () =>
        Number(
          (
            await prisma.$queryRaw<{ n: bigint }[]>`
              SELECT count(*) AS n FROM "JackSearchDoc" WHERE source = 'room_message' AND "sourceId" = ${noteId} AND search @@ plainto_tsquery('english'::regconfig, ${word}::text)`
          )[0].n,
        )
      check((await findsNote()) === 1, "the note is in the search index first (trigger)")

      const deleted = await service.deleteKnowledgeEntry(saved.entry.id, admin)
      check(deleted.ok && deleted.cleared.notes === 1 && deleted.cleared.replies === 1, "the delete clears one note and one reply", deleted)
      const [note, replyAfter, otherAfter] = await Promise.all([noteId, reply.id, other.id].map((id) => prisma.jackMessage.findUniqueOrThrow({ where: { id } })))
      check(note.content === DELETED_KNOWLEDGE_NOTE, "Jack's note says it was deleted instead", note.content)
      check((await findsNote()) === 0, "and search no longer finds the note by its text (the trigger re-indexed it)")
      check(!JSON.stringify(replyAfter.toolCalls).includes(word) && JSON.stringify(replyAfter.toolCalls).includes('"run_sql"'), "the reply's knowledge call lost the text; its other calls stayed", replyAfter.toolCalls)
      check(otherAfter.updatedAt.getTime() === other.updatedAt.getTime(), "other replies are left alone (not even rewritten)", otherAfter.toolCalls)
    }
  } finally {
    await prisma.jackRoom.deleteMany({ where: { id: { in: rooms } } })
    const ids = [...new Set(created)]
    await prisma.knowledgeEntry.deleteMany({ where: { OR: [{ id: { in: ids } }, { tags: { has: MARK } }, { title: { contains: MARK } }] } })
    await prisma.auditLog.deleteMany({ where: { entityType: "KNOWLEDGE_ENTRY", OR: [{ entityId: { in: ids } }, { summary: { contains: MARK } }] } })
    await prisma.$disconnect()
  }
  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed. Everything this run wrote is deleted.")
  if (failures) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
