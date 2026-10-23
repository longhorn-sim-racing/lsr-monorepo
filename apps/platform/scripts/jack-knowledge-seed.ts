/**
 * Lints the knowledge seed files and, once they're signed off, loads them into the knowledge base
 * (#188, design §9). The format is in docs/jack-2/knowledge-seed/README.md: one entry per .md file
 * with front matter (title, tags, sourceNote, sourceDate, owner).
 *
 * THE REPO IS PUBLIC, so the seed files live outside it (default ~/.lsr/jack-knowledge-seed); the
 * script refuses a folder inside the repo.
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/jack-knowledge-seed.ts                       # lint, and show the plan if DATABASE_URL is set
 *   pnpm --filter @lsr/platform exec tsx scripts/jack-knowledge-seed.ts --dir <folder>
 *   pnpm --filter @lsr/platform exec tsx scripts/jack-knowledge-seed.ts --approved=2026-10-25 --actor gray-marshall
 *
 * Without --approved nothing is written. With it, every file must pass the lint first; then new
 * entries are created and changed ones updated (each a new version), as sourceType SEED and reviewed
 * as of the approval date (--approved alone means today), credited to --actor in the audit log. An
 * owner that's a department goes to the department's one board officer (from the officer profiles,
 * so run scripts/sync-officer-badges.ts first), or to no one, and the department is a tag either way.
 * An entry is matched to an earlier load by its title. Seed entries that are no longer in the folder are
 * listed, never deleted. It loads into whatever database DATABASE_URL points at (production is a
 * release step Gray runs); it reads only apps/platform/.env.local and .env, without overriding the
 * environment.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import { duplicateSeedTitles, isSeedFileName, parseSeedFile, type SeedEntry } from "../src/server/jack/knowledge/seed"
import { isCalendarDate, startOfCentralDay } from "../src/server/jack/tools/time"

function flag(name: string): string | undefined {
  const args = process.argv.slice(2)
  const inline = args.find((arg) => arg.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const i = args.indexOf(`--${name}`)
  if (i === -1) return undefined
  const next = args[i + 1]
  return next && !next.startsWith("--") ? next : ""
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

/** The monorepo's root: the nearest folder up from here with pnpm-workspace.yaml */
function repoRoot(): string | null {
  let dir = process.cwd()
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir
    const up = resolve(dir, "..")
    if (up === dir) return null
    dir = up
  }
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name.startsWith(".") || name.startsWith("_") ? [] : markdownFiles(path)
    return isSeedFileName(name) ? [path] : []
  })
}

function loadEnv() {
  const root = repoRoot()
  for (const file of [".env.local", ".env"]) {
    const path = root ? join(root, "apps", "platform", file) : resolve(file)
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
}

function describeTarget(url: string): string {
  try {
    const u = new URL(url)
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`
  } catch {
    return "(unparseable DATABASE_URL)"
  }
}

async function main() {
  const dir = resolve(flag("dir") || join(homedir(), ".lsr", "jack-knowledge-seed"))
  const root = repoRoot()
  if (root && (dir === root || dir.startsWith(root + sep))) {
    fail(`Refusing to read seed files inside the repo (${relative(root, dir) || "."}): the repo is public. Keep them in a private folder outside it, e.g. ~/.lsr/jack-knowledge-seed.`)
  }
  if (!existsSync(dir)) fail(`No seed folder at ${dir}. Make it (outside the repo) or pass --dir <folder>.`)

  const approvedFlag = flag("approved")
  const approving = approvedFlag !== undefined
  const approvedOn = approvedFlag || new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date())
  if (approving && !isCalendarDate(approvedOn)) fail(`--approved takes a date like 2026-10-25 (or nothing, for today), not "${approvedOn}".`)

  // 1. Lint every file; nothing loads unless all of them pass
  const files = markdownFiles(dir)
  console.log(`seed folder  ${dir}`)
  console.log(`files        ${files.length}\n`)
  const entries: SeedEntry[] = []
  let problems = 0
  for (const path of files) {
    const parsed = parseSeedFile(relative(dir, path).split(sep).join("/"), readFileSync(path, "utf8"))
    if (parsed.ok) entries.push(parsed.entry)
    else {
      problems += parsed.errors.length
      console.log(`  ${parsed.file}`)
      for (const error of parsed.errors) console.log(`    - ${error}`)
    }
  }
  for (const dup of duplicateSeedTitles(entries)) {
    problems++
    console.log(`  Two files share the title "${dup.title}": ${dup.files.join(", ")}`)
  }
  if (problems) fail(`\n${problems} problem${problems === 1 ? "" : "s"} to fix. Nothing was loaded.`)
  console.log(`All ${entries.length} entries pass the lint.`)

  loadEnv()
  if (!process.env.DATABASE_URL) {
    if (approving) fail("DATABASE_URL isn't set, so there's nowhere to load them.")
    console.log("DATABASE_URL isn't set, so that's all: no plan against a database.")
    return
  }
  ;(process.env as Record<string, string | undefined>).NODE_ENV ??= "production"

  // 2. The plan: match earlier loads by title, resolve owners
  const { prisma } = await import("../src/server/db")
  const service = await import("../src/server/jack/knowledge/service")
  try {
    console.log(`\ntarget       ${describeTarget(process.env.DATABASE_URL)}`)
    console.log(`mode         ${approving ? `LOAD, reviewed as of ${approvedOn}` : "dry run: nothing is written"}\n`)

    const existing = await prisma.knowledgeEntry.findMany({
      where: { sourceType: "SEED" },
      select: { id: true, title: true, body: true, tags: true, sourceNote: true, sourceDate: true, ownerId: true, reviewedAt: true, archivedAt: true },
    })
    const byTitle = new Map(existing.map((e) => [e.title.toLowerCase(), e]))
    // Owners: a handle is that officer; a department goes to its lead (its one officer with a board
    // seat, from the officer profiles), and to no one when there isn't exactly one
    const handles = [...new Set(entries.flatMap((e) => (e.owner?.kind === "handle" ? [e.owner.handle] : [])))]
    const owners = await prisma.user.findMany({ where: { handle: { in: handles }, status: { not: "deleted" } }, select: { id: true, handle: true } })
    const byHandle = new Map(owners.map((o) => [o.handle, o.id]))
    const missingOwners = handles.filter((h) => !byHandle.has(h))
    if (missingOwners.length) fail(`No account has the handle${missingOwners.length === 1 ? "" : "s"} ${missingOwners.map((h) => `@${h}`).join(", ")}. Fix the owner fields; nothing was loaded.`)
    const leads = await prisma.user.findMany({
      where: { isBoard: true, department: { not: null }, status: { not: "deleted" }, roles: { some: { role: { key: { in: ["officer", "admin"] } } } } },
      select: { id: true, department: true, displayName: true },
    })
    const departmentOwner = new Map<string, string | null>()
    for (const department of new Set(entries.flatMap((e) => (e.owner?.kind === "department" ? [e.owner.id] : [])))) {
      const board = leads.filter((l) => l.department === department)
      departmentOwner.set(department, board.length === 1 ? board[0].id : null)
      console.log(
        board.length === 1
          ? `  owner    ${department} entries go to ${board[0].displayName}, its board officer`
          : `  owner    ${department} entries get no owner (${board.length} board officers in it; the department stays as a tag)`,
      )
    }
    const ownerId = (entry: SeedEntry): string | null =>
      !entry.owner ? null : entry.owner.kind === "handle" ? byHandle.get(entry.owner.handle)! : (departmentOwner.get(entry.owner.id) ?? null)

    const reviewedAt = startOfCentralDay(approvedOn)
    type Plan = { entry: SeedEntry; fields: Parameters<typeof service.createKnowledgeEntry>[0]; current?: (typeof existing)[number] }
    const plans: Plan[] = entries.map((entry) => ({
      entry,
      fields: {
        title: entry.title,
        body: entry.body,
        tags: entry.tags,
        sourceNote: entry.sourceNote,
        sourceDate: startOfCentralDay(entry.sourceDate),
        ownerId: ownerId(entry),
      },
      current: byTitle.get(entry.title.toLowerCase()),
    }))
    const same = (plan: Plan) => {
      const c = plan.current!
      const f = plan.fields
      return (
        c.title === f.title &&
        c.body === f.body &&
        c.tags.join(",") === (f.tags ?? []).join(",") &&
        c.sourceNote === f.sourceNote &&
        c.sourceDate?.getTime() === f.sourceDate?.getTime() &&
        c.ownerId === f.ownerId &&
        (!approving || c.reviewedAt?.getTime() === reviewedAt.getTime())
      )
    }

    let created = 0
    let updated = 0
    let unchanged = 0
    const actorArg = flag("actor")
    const actor = approving && actorArg ? await prisma.user.findFirst({ where: { OR: [{ email: actorArg.toLowerCase() }, { handle: actorArg.replace(/^@/, "").toLowerCase() }] }, select: { id: true } }) : null
    if (approving && !actor) fail("--approved needs --actor <your email or handle>, so the audit log says who loaded them.")
    const writer = { userId: actor?.id ?? null, via: "seed" as const }

    for (const plan of plans) {
      if (plan.current && same(plan)) {
        unchanged++
        console.log(`  same     ${plan.entry.file}`)
        continue
      }
      if (!plan.current) {
        // Not refused (Gray signed these off), but worth a look before loading
        const similar = await service.findKnowledgeDuplicates({ title: plan.entry.title, body: plan.entry.body, tags: plan.entry.tags })
        const note = similar.length ? ` (similar: ${similar.map((s) => `“${s.title}”`).join(", ")})` : ""
        console.log(`  new      ${plan.entry.file}: “${plan.entry.title}”${note}`)
        if (approving) {
          const result = await service.createKnowledgeEntry(plan.fields, writer, { reviewedAt, skipDuplicateCheck: true })
          if (!result.ok) fail(`    Couldn't load it: ${result.error}`)
        }
        created++
        continue
      }
      console.log(`  update   ${plan.entry.file}: “${plan.entry.title}”${plan.current.archivedAt ? " (archived; stays archived)" : ""}`)
      if (approving) {
        const result = await service.updateKnowledgeEntry(plan.current.id, plan.fields, writer, { reviewedAt, allowArchived: true })
        if (!result.ok) fail(`    Couldn't update it: ${result.error}`)
      }
      updated++
    }

    const seeded = new Set(entries.map((e) => e.title.toLowerCase()))
    const gone = existing.filter((e) => !seeded.has(e.title.toLowerCase()) && !e.archivedAt)
    if (gone.length) {
      console.log(`\nSeed entries no longer in the folder (left as they are; archive them on the Knowledge page if they're out of date):`)
      for (const e of gone) console.log(`  ${e.title}`)
    }
    console.log(`\n${approving ? "Loaded" : "Would load"}: ${created} new, ${updated} updated, ${unchanged} unchanged.`)
    if (!approving) console.log("Dry run. Once they're signed off, re-run with --approved[=YYYY-MM-DD] --actor <your email or handle>.")
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
