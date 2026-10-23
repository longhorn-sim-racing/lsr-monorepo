import { z } from "zod"
import { createProposal, type ProposalDeps } from "@/server/jack/proposals/service"
import { PROPOSE_TOOLS, type AnyProposalKind, type ProposeToolName } from "@/server/jack/proposals/types"
import { forModel } from "./display"
import type { AnyJackTool } from "./types"

/**
 * The propose_* tools (#188, design §4.1 and §7.1), built from the proposal kinds that name them. A
 * track adds a kind to its `proposals/kinds/<track>.ts` with `tool` set, and that tool lists it; a tool
 * with no kinds yet isn't sent at all, so the model is never offered an empty one.
 *
 * Each tool takes `{ proposal }`, where `proposal` is one of its kinds' payloads with `kind` added (a
 * union discriminated on `kind`), so the model sees every kind's fields. The union sits under one key
 * because the API takes only an object at the top of a tool's input schema.
 */

/** What each tool is for, before the list of its kinds */
const TOOL_LEADS: Record<ProposeToolName, string> = {
  propose_change: "Propose a change to something already on the site, for an officer to apply.",
  propose_content: "Propose new or changed site content, such as a news post, for an officer to apply.",
  propose_message: "Propose a message to members, for an officer to approve and send.",
  propose_import: "Propose importing data into the site, for an officer to check and apply.",
  propose_discord: "Propose a Discord post or a standing Discord automation, for an officer to approve.",
  propose_deck_publish: "Propose publishing a deck's slides, for an officer to approve.",
  propose_meeting: "Propose meeting records or sponsor prospect updates, for an officer to apply.",
  propose_recurring: "Propose a recurring question, for an officer to approve.",
}

/** The rarer tools wait behind tool search once the model loop supports it (design §7.1) */
const DEFERRED: ProposeToolName[] = ["propose_discord", "propose_deck_publish", "propose_meeting", "propose_recurring"]

const RULES =
  "It puts a proposal card in the room showing exactly what would change. Nothing changes until an officer presses Apply on the card; you never apply it yourself, and you never say it's done until a room note says it was applied. Call it last in a reply, once you have what you need, and then say in a sentence what applying the card will do. A newer proposal for the same thing replaces your older pending one."

/** A kind's payload with its `kind` added, as one member of the tool's union */
function member(kind: AnyProposalKind) {
  const schema = kind.schema as unknown
  if (!(schema instanceof z.ZodObject)) throw new Error(`Proposal kind "${kind.kind}": its schema must be a z.object (refinements are fine) so the ${kind.tool} tool can show its fields`)
  if (Object.hasOwn(schema.shape, "kind")) throw new Error(`Proposal kind "${kind.kind}": its payload can't have a field named "kind" (the ${kind.tool} tool adds it)`)
  return schema.safeExtend({ kind: z.literal(kind.kind).describe("Which kind of proposal this is") })
}

/** One propose_* tool over its kinds, or null when it has none */
export function proposeTool(tool: ProposeToolName, kinds: AnyProposalKind[], deps?: ProposalDeps): AnyJackTool | null {
  if (!kinds.length) return null
  const members = kinds.map(member)
  const proposal = members.length === 1 ? members[0] : z.discriminatedUnion("kind", members as [(typeof members)[number], ...(typeof members)[number][]])
  const lines = kinds.map((kind) => `- ${kind.description}${kind.permission === "admin" ? " Only an admin can apply it." : ""}`)

  return {
    name: tool,
    description: `${TOOL_LEADS[tool]} ${RULES}\n\nKinds (set proposal.kind to one of them):\n${lines.join("\n")}`,
    input: z.object({ proposal: proposal.describe("The proposal: its kind and that kind's fields") }),
    writes: true,
    ...(DEFERRED.includes(tool) ? { deferred: true } : {}),
    async run(input, ctx) {
      const { kind, ...payload } = input.proposal as { kind: string } & Record<string, unknown>
      const outcome = await createProposal({ kind, payload, roomId: ctx.roomId, messageId: ctx.messageId, proposedFor: ctx.actor, signal: ctx.signal }, deps)
      if (!outcome.ok) return { forModel: outcome.error, label: "Proposal not made", isError: true }
      const { proposal: card, superseded } = outcome
      return {
        forModel: forModel({
          proposalId: card.proposalId,
          kind: card.proposalKind,
          status: "PENDING",
          title: card.title,
          summary: card.summary,
          changes: card.preview,
          ...(card.counts ? { counts: card.counts } : {}),
          ...(superseded.length ? { replaced: superseded } : {}),
          note: "The card is in the room. Nothing has changed: an officer has to press Apply. Tell them in a sentence what applying it will do.",
        }),
        label: `Proposed: ${card.title}`,
        displays: [card],
      }
    },
  }
}

/** Every propose_* tool that has kinds, in PROPOSE_TOOLS order */
export function proposeTools(kindsFor: (tool: ProposeToolName) => AnyProposalKind[], deps?: ProposalDeps): AnyJackTool[] {
  return PROPOSE_TOOLS.map((tool) => proposeTool(tool, kindsFor(tool), deps)).filter((tool): tool is AnyJackTool => tool !== null)
}
