/**
 * Renders every slide template in Jack's kit (src/server/jack/decks/templates.ts) with the real
 * renderer, writes the PNGs and previews to .jack-renders/check/, and prints what the checks found
 * (#177). Run it after changing the kit, the templates or the renderer, then look at the images.
 *
 *   pnpm --filter @lsr/platform exec tsx scripts/check-jack-render.ts            # every template
 *   pnpm --filter @lsr/platform exec tsx scripts/check-jack-render.ts --only=cover,stats
 *
 * Uses the machine's Chrome or Edge (or JACK_CHROME_PATH). Needs the network: fonts come from Google
 * Fonts and the photos from the public site. Calls no API and touches no database.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { closeRenderer, renderSlide } from "../src/server/jack/decks/renderer"
import { resolveJackAsset } from "../src/server/jack/decks/renders"
import { SLIDE_TEMPLATES } from "../src/server/jack/decks/templates"

const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length).split(",")
const out = resolve(__dirname, "../.jack-renders/check")
mkdirSync(out, { recursive: true })

async function main() {
  let problems = 0
  const templates = SLIDE_TEMPLATES.filter((t) => !only || only.includes(t.name))
  if (!templates.length) throw new Error(`No template matches ${only?.join(", ")}`)
  for (const template of templates) {
    const rendered = await renderSlide({ size: template.size, css: "", html: template.html }, { assets: resolveJackAsset })
    writeFileSync(resolve(out, `${template.name}.png`), rendered.png)
    writeFileSync(resolve(out, `${template.name}.view.jpg`), rendered.view)
    writeFileSync(resolve(out, `${template.name}.thumb.jpg`), rendered.thumb)
    const kb = (buffer: Buffer) => `${Math.round(buffer.length / 1024)} KB`
    console.log(`${template.name} (${template.size}): ${rendered.ms} ms, png ${kb(rendered.png)}, view ${kb(rendered.view)}, thumb ${kb(rendered.thumb)}`)
    for (const issue of rendered.issues) console.log(`  - ${issue}`)
    problems += rendered.issues.length
  }
  console.log(`\nWrote ${templates.length} renders to ${out}. ${problems ? `${problems} problems found.` : "No problems found."}`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => closeRenderer())
