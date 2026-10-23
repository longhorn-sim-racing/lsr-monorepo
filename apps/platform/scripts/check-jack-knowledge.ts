/**
 * Checks the knowledge service (src/server/jack/knowledge) against the LOCAL database (#188, design §9):
 * the parts unit tests can't, because they live in Postgres. The duplicate check's lexeme counts (the
 * english parser, the search index row the trigger writes), the page's full-text search, versions under
 * the row lock, the "not reviewed" and stale views, and that a hard delete takes the versions and the
 * search index row with it.
 *
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres pnpm --filter @lsr/platform exec tsx scripts/check-jack-knowledge.ts
 *
 * Refuses to run unless DATABASE_URL points at this machine. Writes only entries tagged with this run's
 * marker (and their audit entries), and deletes them all at the end, pass or fail.
 */
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
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
  } finally {
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
