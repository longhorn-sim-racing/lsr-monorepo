import { racePerformanceTool } from "../race-performance"
import { recruitingPipelineTool } from "../recruiting-pipeline"
import { readTool, searchTool } from "../search"
import type { AnyJackTool } from "../types"

/**
 * Jack tools from the club-data track (design §7.1), sent after the core tools in a fixed track order; keep their order stable (it is part of the cached prompt).
 * search and read are always loaded; recruiting_pipeline and race_performance are deferred (found through tool search).
 */
export const TOOLS: AnyJackTool[] = [searchTool, readTool, recruitingPipelineTool, racePerformanceTool]
