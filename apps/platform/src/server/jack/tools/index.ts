import { auditLogTool } from "./audit-log"
import { chartTool } from "./chart"
import { clubMembersTool } from "./club-members"
import { DECK_TOOLS } from "./decks"
import { describeSchemaTool } from "./describe-schema"
import { draftEventTool } from "./draft-event"
import { eventsOverviewTool } from "./events-overview"
import { lscEntriesTool } from "./lsc-entries"
import { memberActivityTool } from "./member-activity"
import { paymentsSummaryTool } from "./payments-summary"
import { SLOT_TOOLS } from "./registry"
import { runSqlTool } from "./run-sql"
import { standingsTool } from "./standings"
import type { AnyJackTool } from "./types"

/**
 * The tools Jack had before 2.0, in their order.
 *
 * Typed tools first, since they carry the definitions (what "paid for LSC" means, effective event
 * status, attendance); describe_schema and run_sql for everything else; chart draws; draft_event is
 * the only write to club data. The deck tools (#177) make slides and graphics, which are Jack's own.
 */
export const CORE_JACK_TOOLS: AnyJackTool[] = [
  clubMembersTool,
  memberActivityTool,
  eventsOverviewTool,
  lscEntriesTool,
  paymentsSummaryTool,
  standingsTool,
  auditLogTool,
  describeSchemaTool,
  runSqlTool,
  chartTool,
  draftEventTool,
  ...DECK_TOOLS,
]

/**
 * Every tool Jack can use, in a fixed order (the order is part of the cached prompt, so keep it stable):
 * the core tools, then the tools each Jack 2.0 track adds in its slot (`registry/<track>.ts`), in track
 * order. The model loop sends whatever is here.
 */
export const JACK_TOOLS: AnyJackTool[] = [...CORE_JACK_TOOLS, ...SLOT_TOOLS]

for (const [i, tool] of JACK_TOOLS.entries()) {
  if (JACK_TOOLS.findIndex((other) => other.name === tool.name) !== i) throw new Error(`Duplicate Jack tool "${tool.name}": a track's slot reuses a core tool's name`)
}

export function findJackTool(name: string): AnyJackTool | undefined {
  return JACK_TOOLS.find((tool) => tool.name === name)
}
