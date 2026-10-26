import { sweepProposals } from "@/server/jack/proposals/service"
import type { JobKind } from "../types"

/**
 * The proposal sweep (design §4.1 step 5, §6): applies that stopped partway (still APPLYING after 10
 * minutes) become FAILED, never retried, and pending proposals past their 14 days become STALE, each
 * with its room note. Expiry is lazy anyway (a proposal reads as stale once it's due); this writes it
 * down, so the Proposals page and Jack's history say so too. Joined into the groundwork slot by the
 * scheduler registry.
 */
export const proposalSweepJob: JobKind = {
  kind: "proposals.sweep",
  label: "Proposal sweep",
  description: "Marks Jack's proposals that stopped partway through applying as failed, and pending ones older than 14 days as stale, with a note in their rooms.",
  defaultSchedule: "*/10 * * * *",
  budgetMs: 30_000,
  async run({ signal, log }) {
    const { failed, expired } = await sweepProposals({ signal })
    if (failed) log(`${failed} stopped partway through applying: marked failed`)
    if (expired) log(`${expired} expired: marked stale`)
    return {
      summary: failed || expired ? `Failed ${failed} stuck apply${failed === 1 ? "" : "s"}, expired ${expired} proposal${expired === 1 ? "" : "s"}` : "Nothing to sweep",
      counts: { failed, expired },
    }
  },
}

export const JOBS: JobKind[] = [proposalSweepJob]
