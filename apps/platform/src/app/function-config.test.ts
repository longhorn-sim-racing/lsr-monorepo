import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

/*
 * Vercel puts routes with different function settings in different functions, and the Hobby plan takes
 * at most 12 functions per deployment (previews of jack-2 failed with "No more than 12 Serverless
 * Functions" before this). So every page and route runs with the project's defaults: 300 s on Fluid
 * compute, the most Hobby allows (FUNCTION_MAX_MS in server/scheduler/dispatcher.ts), Node.js, iad1.
 * A route that needs something else should say why in its PR; the function count is the cost.
 */
const APP_DIR = path.join(__dirname)
const SEGMENT_FILE = /^(page|route|layout|template|default)\.(ts|tsx)$/
const FUNCTION_SETTING = /^export const (maxDuration|runtime|preferredRegion)\b/m

function segmentFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return segmentFiles(full)
    return SEGMENT_FILE.test(entry.name) ? [full] : []
  })
}

describe("pages and routes", () => {
  it("set no function settings of their own (Vercel Hobby allows 12 functions per deployment)", () => {
    const files = segmentFiles(APP_DIR)
    expect(files.length).toBeGreaterThan(50)
    const withSettings = files.filter((file) => FUNCTION_SETTING.test(readFileSync(file, "utf8"))).map((file) => path.relative(APP_DIR, file))
    expect(withSettings).toEqual([])
  })
})
