/**
 * PAID (a few cents): checks that a link only inside a PDF document in the officer's turn can't be fetched
 * by web_fetch, which is why PDFs go to Claude as documents with web fetch on (docs/jack-2/tracks/files.md,
 * release step 5). Two requests, with web fetch as webServerTools() builds it and a PDF on Claude Files:
 * - the link only inside the PDF: the fetch of exactly that link must fail with url_not_in_prior_context;
 * - control, the same kind of link in the officer's text: the fetch must get past that check (it fails
 *   later, url_not_allowed or url_not_accessible, because .example isn't a real site).
 * Run it again whenever the web_fetch tool version changes:
 *
 *   ANTHROPIC_API_KEY=… pnpm --filter @lsr/platform exec tsx scripts/check-jack-web-fetch-documents.ts
 *
 * The PDF is deleted from Claude Files at the end, pass or fail. Exits 1 if either check fails.
 */
import Anthropic, { toFile } from "@anthropic-ai/sdk"
import type { BetaContentBlock, BetaContentBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { randomBytes } from "node:crypto"
import { textPdf } from "./jack-eval/room-files"
import { webServerTools } from "../src/server/jack/web-tools"

const MODEL = "claude-sonnet-5-5"

type Fetched = { url: string | null; result: string }

/** The web_fetch calls a response made (directly or from code execution) and what each got */
function fetches(content: BetaContentBlock[]): Fetched[] {
  const calls = new Map<string, Fetched>()
  for (const block of content as unknown as { type: string; id?: string; name?: string; input?: { url?: unknown }; tool_use_id?: string; content?: { type?: string; error_code?: string } }[]) {
    if (block.type === "server_tool_use" && block.name === "web_fetch" && block.id) {
      calls.set(block.id, { url: typeof block.input?.url === "string" ? block.input.url : null, result: "no result" })
    } else if (block.type === "web_fetch_tool_result" && block.tool_use_id && calls.has(block.tool_use_id)) {
      calls.get(block.tool_use_id)!.result = block.content?.error_code ?? block.content?.type ?? "unknown"
    }
  }
  return [...calls.values()]
}

async function ask(client: Anthropic, content: BetaContentBlockParam[]): Promise<Fetched[]> {
  const res = await client.beta.messages.create({ model: MODEL, max_tokens: 800, tools: webServerTools([]), messages: [{ role: "user", content }] })
  return fetches(res.content)
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new Error("ANTHROPIC_API_KEY isn't set (this check makes two paid requests)")
  const client = new Anthropic()
  const inPdf = `https://probe-${randomBytes(6).toString("hex")}.example/notes`
  const inText = `https://probe-${randomBytes(6).toString("hex")}.example/notes`
  const pdf = await textPdf("probe.pdf", ["Probe document.", `Our notes are at ${inPdf} and nowhere else.`])
  const uploaded = await client.files.upload({ file: await toFile(pdf.bytes, "jack-probe.pdf", { type: "application/pdf" }) })
  let failed = false
  const report = (ok: boolean, what: string, detail: string) => {
    if (!ok) failed = true
    console.log(`${ok ? "PASS" : "FAIL"}  ${what}  (${detail})`)
  }
  try {
    const fromPdf = await ask(client, [
      { type: "document", source: { type: "file", file_id: uploaded.id }, title: "probe.pdf" },
      { type: "text", text: "Use web_fetch to open exactly the link written in the attached PDF, and tell me what the page says. Don't search; just fetch that one link." },
    ])
    const exact = fromPdf.find((f) => f.url === inPdf)
    report(Boolean(exact), "the model tried to fetch exactly the PDF's link", JSON.stringify(fromPdf))
    report(exact?.result === "url_not_in_prior_context", "a link only inside a PDF document can't be fetched", exact?.result ?? "not fetched")

    const fromText = await ask(client, [{ type: "text", text: `Use web_fetch to open exactly ${inText} and tell me what the page says. Don't search; just fetch that one link.` }])
    const control = fromText.find((f) => f.url === inText)
    report(Boolean(control) && control!.result !== "url_not_in_prior_context", "control: the same kind of link in the officer's text gets past that check", control?.result ?? "not fetched")
  } finally {
    await client.files.delete(uploaded.id).catch((error) => console.error("Couldn't delete the probe PDF from Claude Files:", error instanceof Error ? error.message : error))
  }
  if (failed) process.exit(1)
  console.log("\nAll checks passed.")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
