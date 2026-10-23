/**
 * Prints the size of Jack's cached prefix (design §8): the system prompt and the tool definitions every
 * request loads, with what each track adds and its budget (src/server/jack/prompt-size.ts; the budgets
 * are checked by prompt-size.test.ts). Reads no database and calls nothing.
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/jack-prompt-size.ts
 *
 * Characters are exact (what the request sends). Tokens are a rough guide only (characters / 3.5); the
 * API adds its own instructions for server tools (tool search, web search and fetch) on top.
 */

// A module, not a global script (so main() doesn't clash with other scripts'); the imports are dynamic so DATABASE_URL is set first
export {}

async function main() {
  // The tools import the database client; nothing here queries it
  process.env.DATABASE_URL ??= "postgresql://localhost:5432/unused"
  const { deferredSize, loadedSize, measurePrompt, PREFIX_MAX_CHARS, TRACK_BUDGETS } = await import("../src/server/jack/prompt-size")
  const size = measurePrompt()
  const n = (value: number) => value.toLocaleString("en-US")
  const tokens = (value: number) => `~${n(Math.round(value / 3.5))} tokens`
  const pad = (text: string | number, width: number) => String(text).padStart(width)

  console.log("Jack's cached prefix (characters)\n")
  console.log(`System prompt: jack ${n(size.system.jack)}, lift ${n(size.system.lift)}, stand ${n(size.system.stand)} (of which notes on the database ${n(size.schemaNotes)})`)
  const tracks = size.tracks.reduce((sum, t) => sum + t.tools + t.kinds, 0)
  console.log(`Always-loaded tool definitions: ${n(size.tools)} (core tools ${n(size.coreTools)}, tracks ${n(tracks)}, shared: tool search ${n(size.shared.toolSearch)} and propose_* leads ${n(size.shared.propose)})`)
  console.log(`Deferred tool definitions (tool search): ${n(size.deferredTools)}; web tools add ${n(size.webTools)} when on`)
  console.log(`Prefix: ${n(size.prefix.noWeb)} (${tokens(size.prefix.noWeb)}), ${n(size.prefix.web)} with the web tools; budget ${n(PREFIX_MAX_CHARS)}\n`)

  const header = ["track", "section", "pages", "tools", "kinds", "loaded", "budget", "deferred", "budget"]
  const widths = [18, 8, 6, 7, 7, 7, 7, 9, 7]
  console.log(header.map((h, i) => (i ? pad(h, widths[i]) : h.padEnd(widths[i]))).join(" "))
  for (const t of size.tracks) {
    const budget = TRACK_BUDGETS[t.track]
    const row = [t.track.padEnd(widths[0]), pad(n(t.section), widths[1]), pad(n(t.pages), widths[2]), pad(n(t.tools), widths[3]), pad(n(t.kinds), widths[4]), pad(n(loadedSize(t)), widths[5]), pad(n(budget.loaded), widths[6]), pad(n(deferredSize(t)), widths[7]), pad(n(budget.deferred), widths[8])]
    console.log(row.join(" "))
  }
  console.log("\nloaded = section + pages + tools + kinds (in every request); deferred = tools and kinds behind tool search")
  console.log("kinds = what a track's proposal kinds add to the propose_* tools (a tool only its kinds use counts whole)")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
