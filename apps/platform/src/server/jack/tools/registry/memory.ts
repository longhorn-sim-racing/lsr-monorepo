import { knowledgeTool } from "../knowledge"
import type { AnyJackTool } from "../types"

/** Jack tools from the memory track (design §7.1), sent after the core tools in a fixed track order; keep their order stable (it is part of the cached prompt) */
export const TOOLS: AnyJackTool[] = [knowledgeTool]
