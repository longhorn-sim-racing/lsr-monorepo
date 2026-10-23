/**
 * LOCAL ONLY: checks how synced documents' names and folders are indexed for Jack's `search` (#188,
 * migration 20261024020000_jack2_document_name_search), against the real local Postgres:
 *
 *   - a name with an extension, dashes or underscores is found by its words ("Venue Contract.pdf" by
 *     "contract"), and still by the whole file token ("contract.pdf")
 *   - a folder path is found by its words ("Shared/Meeting Notes" by "meeting notes")
 *   - a plain name is indexed once, as before
 *   - renaming re-indexes (the old word no longer finds it), deleting removes it
 *   - every document's index row matches jack2_document_vector() (the migration's re-index and the
 *     trigger agree)
 *   - Jack's SQL role still can't read the index or call the function; the index keeps row level security
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/check-jack-document-search.ts
 *
 * Writes ExternalDocument rows under a throwaway source (with their index rows, through the trigger) and
 * deletes them at the end, pass or fail. Refuses unless DATABASE_URL points at 127.0.0.1 or localhost.
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

const databaseProblem = localDatabaseProblem("DATABASE_URL", process.env.DATABASE_URL)
if (databaseProblem) {
  console.error(`Refusing to run: ${databaseProblem}`)
  process.exit(1)
}
;(process.env as Record<string, string | undefined>).NODE_ENV ??= "production"

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++
  else fail++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${detail}`}`)
}

async function main() {
  const { prisma } = await import("../src/server/db")
  const source = `check-names-${randomBytes(4).toString("hex")}`

  /** Whether a query finds the document, the way the documents search source matches */
  const finds = async (id: string, query: string) => {
    const [row] = await prisma.$queryRaw<{ hit: boolean }[]>`SELECT EXISTS (SELECT 1 FROM "JackSearchDoc" WHERE source = 'document' AND "sourceId" = ${id} AND search @@ websearch_to_tsquery('english', ${query})) AS hit`
    return row?.hit === true
  }
  const lexemes = async (id: string) => {
    const [row] = await prisma.$queryRaw<{ text: string | null }[]>`SELECT search::text AS text FROM "JackSearchDoc" WHERE source = 'document' AND "sourceId" = ${id}`
    return row?.text ?? null
  }
  const save = (externalId: string, name: string, path: string, text: string | null) =>
    prisma.externalDocument.create({
      data: { source, externalId, name, path, mimeType: "application/pdf", webUrl: `https://example.com/${externalId}`, modifiedAt: new Date(), text, textStatus: text ? "ok" : "none", syncedAt: new Date() },
    })

  try {
    const contract = await save("contract", "Venue Contract.pdf", "Check Shared/Legal", null)
    check('"Venue Contract.pdf" is found by "contract" (nothing else in it has the word)', await finds(contract.id, "contract"), (await lexemes(contract.id)) ?? "not indexed")
    check('…by "venue contract" and "contract pdf"', (await finds(contract.id, "venue contract")) && (await finds(contract.id, "contract pdf")))
    check('…and still by the whole file token "contract.pdf"', await finds(contract.id, "contract.pdf"))

    const deck = await save("deck", "sponsor_deck-2026_final.pptx", "Check Shared/Meeting Notes", "Tiers and prices.")
    check('"sponsor_deck-2026_final.pptx" is found by "sponsor deck final"', await finds(deck.id, "sponsor deck final"), (await lexemes(deck.id)) ?? "not indexed")
    check('its folder "Check Shared/Meeting Notes" is found by "meeting notes"', await finds(deck.id, "meeting notes"))
    check("its text is still indexed", await finds(deck.id, "tiers prices"))

    const plain = await save("plain", "Budget", "Club", "Spring numbers")
    const plainLexemes = await lexemes(plain.id)
    check("a plain name is indexed once, as before", plainLexemes === "'budget':1A 'club':2B 'number':4C 'spring':3C", plainLexemes ?? "not indexed")

    await prisma.externalDocument.update({ where: { id: contract.id }, data: { name: "Venue Agreement.pdf" } })
    check("renaming re-indexes: the new word finds it, the old one doesn't", (await finds(contract.id, "agreement")) && !(await finds(contract.id, "contract")))

    const [agrees] = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "ExternalDocument" e LEFT JOIN "JackSearchDoc" d ON d.source = 'document' AND d."sourceId" = e.id WHERE d.search IS DISTINCT FROM public.jack2_document_vector(e.name, e.path, e.text)`
    check("every document's index row matches jack2_document_vector() (the re-index and the trigger agree)", agrees?.n === 0, `${agrees?.n} rows differ`)

    await prisma.externalDocument.delete({ where: { id: deck.id } })
    check("deleting a document removes its index row", (await lexemes(deck.id)) === null)

    const [access] = await prisma.$queryRaw<{ rls: boolean; role: boolean; reads: boolean | null; calls: boolean | null }[]>`
      SELECT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public."JackSearchDoc"'::regclass) AS rls,
        EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jack_readonly') AS role,
        CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jack_readonly') THEN has_table_privilege('jack_readonly', 'public."JackSearchDoc"', 'SELECT') END AS reads,
        CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jack_readonly') THEN has_function_privilege('jack_readonly', 'public.jack2_document_vector(text, text, text)', 'EXECUTE') END AS calls`
    check(
      "the index keeps row level security, and Jack's SQL role can't read it or call the function",
      access?.rls === true && access.role && access.reads === false && access.calls === false,
      JSON.stringify(access),
    )
  } finally {
    await prisma.externalDocument.deleteMany({ where: { source } })
    const [left] = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "JackSearchDoc" d WHERE d.source = 'document' AND NOT EXISTS (SELECT 1 FROM "ExternalDocument" e WHERE e.id = d."sourceId")`
    console.log(left?.n ? `WARNING: ${left.n} document index rows have no document` : "(deleted the check documents and their index rows)")
    await prisma.$disconnect()
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
