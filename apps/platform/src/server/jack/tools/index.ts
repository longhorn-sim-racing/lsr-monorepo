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
import { runSqlTool } from "./run-sql"
import { standingsTool } from "./standings"
import type { AnyJackTool } from "./types"

/**
 * Every tool Jack can use, in a fixed order (the order is part of the cached prompt, so keep it stable).
 * The model loop sends whatever is here.
 *
 * Typed tools first, since they carry the definitions (what "paid for LSC" means, effective event
 * status, attendance); describe_schema and run_sql for everything else; chart draws; draft_event is
 * the only write to club data. The deck tools (#177) make slides and graphics, which are Jack's own.
 */
export const JACK_TOOLS: AnyJackTool[] = [
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

export function findJackTool(name: string): AnyJackTool | undefined {
  return JACK_TOOLS.find((tool) => tool.name === name)
}
