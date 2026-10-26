import { draftTextTool } from "../draft-text"
import { meetingsListTool } from "../meetings-list"
import { sponsorsListTool } from "../sponsors-list"
import type { AnyJackTool } from "../types"

/**
 * Jack tools from the sponsors-meetings track (design §7.1), sent after the core tools in a fixed track order; keep their order stable (it is part of the cached prompt).
 * draft_text is always loaded; sponsors_list and meetings_list are deferred (found through tool search). The track's proposal kinds are on propose_meeting and propose_change.
 */
export const TOOLS: AnyJackTool[] = [draftTextTool, sponsorsListTool, meetingsListTool]
