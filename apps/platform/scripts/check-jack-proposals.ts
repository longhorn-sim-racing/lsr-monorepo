/**
 * LOCAL ONLY: checks Jack's proposal framework (#188, src/server/jack/proposals/service.ts) against the
 * real local Postgres, where the unit tests use a fake: the claim (several officers clicking Apply at
 * once, exactly one wins), superseding in a transaction, lazy expiry, discard, the saved view and the
 * room notes. A test kind changes an in-memory value, so no club data is touched; nothing is broadcast.
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/check-jack-proposals.ts
 *
 * Uses an existing officer or admin (read only). Writes a room (with its proposals and notes) and the
 * audit entries the checks make, and deletes them all at the end, pass or fail. Refuses unless
 * DATABASE_URL points at 127.0.0.1 or localhost.
 */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { z } from "zod"

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
  const { prisma } = await import("../src/server/db")
  const service = await import("../src/server/jack/proposals/service")
  type Kind = import("../src/server/jack/proposals/types").AnyProposalKind

  const officer = await prisma.user.findFirst({ where: { roles: { some: { role: { key: { in: ["admin", "officer"] } } } } }, orderBy: { createdAt: "asc" } })
  if (!officer) throw new Error("No officer or admin in this database: pnpm set-role <email> admin")
  const me = { id: officer.id, displayName: officer.displayName }

  const values = new Map<string, string>([["a", "old"], ["b", "old"], ["c", "old"]])
  let applies = 0
  const schema = z.object({ key: z.string(), value: z.string() })
  const kind: Kind = {
    kind: "check.value",
    tool: "propose_change",
    description: "Sets a value, for scripts/check-jack-proposals.ts",
    schema,
    targetType: "CHECK",
    permission: "officer",
    async prepare(p: z.infer<typeof schema>) {
      return {
        before: { value: values.get(p.key) },
        targetId: p.key,
        view: { title: `Set ${p.key}`, summary: `Sets ${p.key} to ${p.value}.`, diff: [{ field: "value", label: "Value", before: values.get(p.key) ?? null, after: p.value, format: "text" as const }] },
      }
    },
    async checkStale(p: z.infer<typeof schema>, before: unknown) {
      return values.get(p.key) === (before as { value?: string }).value ? null : `${p.key} changed.`
    },
    async apply(p: z.infer<typeof schema>) {
      applies++
      await new Promise((done) => setTimeout(done, 50))
      values.set(p.key, p.value)
      return { summary: `Set ${p.key}.`, links: [{ title: "Check", url: `/admin/check/${p.key}` }] }
    },
  }
  const deps = { ...service.defaultProposalDeps, broadcast: async () => {}, findKind: (k: string) => (k === kind.kind ? kind : undefined) }
  const proposedFor = { userId: officer.id, displayName: officer.displayName }

  const room = await prisma.jackRoom.create({ data: { createdById: officer.id, title: `check-jack-proposals ${Date.now().toString(36)}` } })
  const ids: string[] = []
  const propose = async (key: string, value: string) => {
    const outcome = await service.createProposal({ kind: kind.kind, payload: { key, value }, roomId: room.id, proposedFor }, deps)
    if (!outcome.ok) throw new Error(outcome.error)
    ids.push(outcome.proposal.proposalId)
    return outcome
  }

  try {
    // Superseding, in a real transaction
    const first = await propose("a", "one")
    const second = await propose("a", "two")
    const firstRow = await prisma.jackProposal.findUnique({ where: { id: first.proposal.proposalId } })
    check("a newer proposal for the same target supersedes the older one", firstRow?.status === "SUPERSEDED" && firstRow.supersededById === second.proposal.proposalId, JSON.stringify(firstRow?.status))
    const secondRow = await prisma.jackProposal.findUnique({ where: { id: second.proposal.proposalId } })
    check("the view, payload and snapshot are saved as JSON", (secondRow?.view as { title?: string } | null)?.title === "Set a" && (secondRow?.before as { value?: string } | null)?.value === "old", JSON.stringify(secondRow?.view))

    // The claim: five officers click Apply at once
    const results = await Promise.all(Array.from({ length: 5 }, () => service.applyProposal(second.proposal.proposalId, me, {}, deps)))
    const winners = results.filter((r) => r.ok).length
    check("of five Applies at once, exactly one applies", winners === 1 && applies === 1, `${winners} applied, apply() ran ${applies} times`)
    const applied = await prisma.jackProposal.findUnique({ where: { id: second.proposal.proposalId } })
    check("it ends APPLIED, with the result and who applied it", applied?.status === "APPLIED" && applied.decidedById === officer.id && (applied.result as { summary?: string } | null)?.summary === "Set a.", JSON.stringify(applied?.status))
    const audits = await prisma.auditLog.count({ where: { entityType: "JACK_PROPOSAL", entityId: second.proposal.proposalId, actionType: "APPLY" } })
    check("one audit entry for the apply", audits === 1, `${audits} entries`)

    // Staleness
    const stale = await propose("b", "two")
    values.set("b", "changed elsewhere")
    const staleResult = await service.applyProposal(stale.proposal.proposalId, me, {}, deps)
    check("a changed target makes it STALE, not applied", !staleResult.ok && staleResult.proposal?.status === "STALE" && values.get("b") === "changed elsewhere", JSON.stringify(staleResult))

    // Lazy expiry
    const old = await propose("c", "two")
    await prisma.jackProposal.update({ where: { id: old.proposal.proposalId }, data: { expiresAt: new Date(Date.now() - 1_000) } })
    const states = await service.roomProposalStates(room.id)
    check("an expired pending proposal reads as STALE in the room", states[old.proposal.proposalId]?.status === "STALE", JSON.stringify(states[old.proposal.proposalId]))
    const expired = await service.applyProposal(old.proposal.proposalId, me, {}, deps)
    const oldRow = await prisma.jackProposal.findUnique({ where: { id: old.proposal.proposalId } })
    check("applying it marks it STALE instead (the claim's expiresAt > now)", !expired.ok && oldRow?.status === "STALE" && values.get("c") === "old", JSON.stringify(oldRow?.status))

    // Discard, and the detail the card loads
    const toDiscard = await propose("a", "three")
    const discarded = await service.discardProposal(toDiscard.proposal.proposalId, me, deps)
    const again = await service.discardProposal(toDiscard.proposal.proposalId, me, deps)
    check("discarding works once", discarded.ok && !again.ok, JSON.stringify({ discarded: discarded.ok, again }))
    const detail = await service.getProposalDetail(second.proposal.proposalId, officer.id, deps)
    check("the card's detail names who applied it", detail?.decidedBy === officer.displayName && detail.status === "APPLIED", JSON.stringify(detail?.decidedBy))

    const notes = await prisma.jackMessage.findMany({ where: { roomId: room.id, kind: "system" }, orderBy: { createdAt: "asc" }, select: { content: true } })
    const texts = notes.map((n) => n.content)
    check(
      "every final status left a room note",
      texts.some((t) => t.startsWith("Superseded: Set a")) &&
        texts.some((t) => t === `${officer.displayName} applied: Set a → /admin/check/a`) &&
        texts.some((t) => t.startsWith("Stale: Set b. b changed")) &&
        texts.some((t) => t.startsWith("Stale: Set c. Nobody applied it")) &&
        texts.some((t) => t === `Discarded by ${officer.displayName}: Set a`),
      JSON.stringify(texts),
    )
  } finally {
    await prisma.auditLog.deleteMany({ where: { entityType: "JACK_PROPOSAL", entityId: { in: ids } } })
    await prisma.jackRoom.delete({ where: { id: room.id } })
    const left = await prisma.jackProposal.count({ where: { id: { in: ids } } })
    console.log(left ? `WARNING: ${left} check proposals were left behind` : "(deleted the check room, its proposals and notes, and their audit entries)")
    await prisma.$disconnect()
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
