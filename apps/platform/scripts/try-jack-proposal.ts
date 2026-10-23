/**
 * LOCAL ONLY: puts a page.update proposal card in a Jack room without calling Claude (#188), to try the
 * card, Apply, Discard and the room notes in the browser. A scripted fake Claude answers an officer's
 * message through the real reply loop and calls propose_change, exactly as Jack would; nothing is spent.
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/try-jack-proposal.ts                     # a new room, the LSC rules page
 *   pnpm --filter @lsr/platform exec tsx scripts/try-jack-proposal.ts --page=<slug>       # another page
 *   pnpm --filter @lsr/platform exec tsx scripts/try-jack-proposal.ts --room=<id>         # an existing room
 *   pnpm --filter @lsr/platform exec tsx scripts/try-jack-proposal.ts --as=<email|handle> # asked by this officer
 *
 * The proposal edits the page's first line that appears only once. Apply it in the room to change the
 * page (the admin Pages editor puts it back). Leaves the room and its messages for you to look at.
 * Refuses unless DATABASE_URL points at 127.0.0.1 or localhost. Without NEXT_PUBLIC_SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY it can't broadcast, so reload the room to see the reply.
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

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)

async function main() {
  const { prisma } = await import("../src/server/db")
  const { postOfficerMessage } = await import("../src/server/jack/rooms")
  const { defaultReplyDeps } = await import("../src/server/jack/reply-loop")
  const { fakeClaude } = await import("../src/server/jack/fake-claude")
  const { LSC_RULES_SLUG } = await import("../src/lib/page-slugs")

  const as = arg("as")
  const officer = await prisma.user.findFirst({
    where: { roles: { some: { role: { key: { in: ["admin", "officer"] } } } }, ...(as ? { OR: [{ email: as }, { handle: as }] } : {}) },
    orderBy: { createdAt: "asc" },
  })
  if (!officer) throw new Error(as ? `No officer or admin "${as}".` : "No officer or admin in this database: pnpm set-role <email> admin")

  const slug = arg("page") ?? LSC_RULES_SLUG
  const page = (await prisma.page.findUnique({ where: { slug } })) ?? (arg("page") ? null : await prisma.page.findFirst({ orderBy: { updatedAt: "desc" } }))
  if (!page) throw new Error(`No page "${slug}". Make one in Admin → Pages (or run scripts/seed-lsc-rules.ts).`)
  const find = page.bodyMd.split("\n").find((line) => line.trim().length > 3 && page.bodyMd.split(line).length === 2)
  if (!find) throw new Error(`The page "${page.title}" has no line that appears only once to edit.`)
  const replace = `${find} (edited by the proposal check)`

  const roomId = arg("room") ?? (await prisma.jackRoom.create({ data: { createdById: officer.id, title: "Proposal check" } })).id
  const fake = fakeClaude([
    {
      text: "I'll propose that edit.",
      tools: [{ name: "propose_change", input: { proposal: { kind: "page.update", pageId: page.id, edits: [{ find, replace }] } } }],
    },
    { text: `The card above changes one line of “${page.title}”. Nothing changes until an officer presses Apply.` },
  ])
  const replyDeps = { ...defaultReplyDeps, getClient: () => fake.client, budget: async () => ({ month: "check", spentUsd: 0, budgetUsd: 1 }) }

  // Outside a request, the reply runs inline: this returns once it's done
  await postOfficerMessage(roomId, officer.id, `Please add a note to the first line of the “${page.title}” page.`, { replyDeps })

  const proposal = await prisma.jackProposal.findFirst({ where: { roomId }, orderBy: { createdAt: "desc" } })
  if (!proposal) {
    const reply = await prisma.jackMessage.findFirst({ where: { roomId, kind: "assistant" }, orderBy: { createdAt: "desc" } })
    throw new Error(`No proposal was made. The reply's tools: ${JSON.stringify(reply?.toolCalls)}`)
  }
  console.log(`Proposed “${proposal.title}” (${proposal.id}), ${proposal.status}, as ${officer.displayName} asked.`)
  console.log(`Open the room: http://localhost:3000/admin/jack/${roomId}`)
  console.log(`All proposals: http://localhost:3000/admin/jack/proposals`)
  await prisma.$disconnect()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
