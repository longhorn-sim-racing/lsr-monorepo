import type { BetaContentBlockParam, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages"
import { redactSecrets } from "@/lib/redact"
import { prisma } from "@/server/db"
import type { ClaudeFilesClient } from "@/server/connectors/anthropic/files"
import { errorText } from "@/server/connectors/state"
import { jackFileStore, type JackFileStore } from "@/server/jack/decks/storage"
import { claudeCandidateSelect, claudeFilesForUploads, claudeIdsReachModel, ensureClaudeIds, MAX_DOCUMENT_PAGES, pdfFitsAsDocument } from "./claude"
import { FILE_KIND_LABEL, fileSummary, shownName, sizeLabel, SUMMARY_CHARS, type HistoryFile } from "./describe"

/**
 * What Jack sees of the files posted in the turn he's answering (design §5). The history names every
 * file under its message (history.ts); this adds the files themselves after the turn's text:
 * - photos as images and PDFs as documents, by Claude Files id when Claude Files is on (a photo without
 *   one goes as its model copy, inline), within this turn's limits;
 * - past the limits, or a PDF Claude can't take, its text instead (with web fetch on too: links in a
 *   document aren't user input for web_fetch, checked live on 10/23, docs/jack-2/tracks/files.md);
 * - text-like files (CSV, spreadsheets, JSON, text, transcripts, Word) as a short summary.
 * Earlier turns' files aren't sent again; room_files reads any of them.
 */

export type TurnFileLimits = {
  /**
   * Photos shown as images. Over 20 image blocks in a request, every image must be at most 2000 px on
   * a side; model copies are, and so are deck renders
   */
  maxImages: number
  /** PDF pages shown as documents (design §5: about 100 a turn) */
  maxPdfPages: number
  /** PDFs shown as documents, by their size (design §5: about 20 MB a turn) */
  maxPdfBytes: number
  /** Photos sent inline (when they aren't on Claude Files), by their copy's size: a request is at most 32 MB */
  maxInlineBytes: number
  /** One text-like file's summary, in characters */
  summaryChars: number
  /** A PDF shown as its text, in characters */
  pdfTextChars: number
  /** How long loading the files (checking or uploading Claude Files copies, then reading photo copies) may hold up the reply */
  loadMs: number
}

export const TURN_FILE_LIMITS: TurnFileLimits = {
  maxImages: 20,
  maxPdfPages: 100,
  maxPdfBytes: 20_000_000,
  maxInlineBytes: 12_000_000,
  summaryChars: SUMMARY_CHARS,
  pdfTextChars: 8_000,
  loadMs: 10_000,
}

export type TurnFileOptions = {
  store?: JackFileStore
  /** Claude Files; by default the connector's client (null while it's off). Tests pass one, or null */
  claude?: ClaudeFilesClient | null
  /** Whether Files API ids may go to the model (claudeIdsReachModel) */
  sendIds?: boolean
  signal?: AbortSignal
  limits?: Partial<TurnFileLimits>
}

/** Before the files: the officer's line names them, the same in every turn, so this says they're here */
export const FILES_FOLLOW = "(The files attached in this turn follow.)"

/** In place of the files when they couldn't be loaded at all */
export const FILES_UNAVAILABLE = "(The files attached in this turn couldn't be loaded just now. room_files reads them by id.)"

/**
 * The history with the turn's files added after the last officer turn's text. Never throws: when the
 * files can't be loaded the turn says so, and the reply goes ahead.
 */
export async function attachTurnFiles(history: BetaMessageParam[], attached: HistoryFile[], options: TurnFileOptions = {}): Promise<BetaMessageParam[]> {
  const last = history.at(-1)
  if (!attached.length || last?.role !== "user") return history
  const lead: BetaContentBlockParam[] = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content
  let blocks: BetaContentBlockParam[]
  try {
    blocks = [{ type: "text", text: FILES_FOLLOW }, ...(await turnFileBlocks(attached, options))]
  } catch (error) {
    console.error("[jack] Couldn't load a turn's files:", redactSecrets(errorText(error)))
    blocks = [{ type: "text", text: FILES_UNAVAILABLE }]
  }
  return [...history.slice(0, -1), { role: "user", content: [...lead, ...blocks] }]
}

const turnFileSelect = { ...claudeCandidateSelect, filename: true, sizeBytes: true, status: true, text: true, width: true, height: true } as const

type TurnFile = {
  id: string
  kind: HistoryFile["kind"]
  filename: string
  sizeBytes: number
  status: string
  storagePath: string
  modelCopyPath: string | null
  anthropicFileId: string | null
  pageCount: number | null
  textStatus: string | null
  text: string | null
  width: number | null
  height: number | null
}

/** How each file goes, decided in order against the turn's limits */
type Plan = { file: TurnFile; as: "image" | "document" | "text" | "summary" | "note"; why?: string }

async function turnFileBlocks(attached: HistoryFile[], options: TurnFileOptions): Promise<BetaContentBlockParam[]> {
  const limits = { ...TURN_FILE_LIMITS, ...options.limits }
  const store = options.store ?? jackFileStore()
  const rows: TurnFile[] = await prisma.jackFile.findMany({ where: { id: { in: attached.map((file) => file.id) } }, select: turnFileSelect })
  const byId = new Map(rows.map((row) => [row.id, row]))

  const plans: Plan[] = []
  let images = 0
  let pdfPages = 0
  let pdfBytes = 0
  const gone: HistoryFile[] = []
  for (const mention of attached) {
    const file = byId.get(mention.id)
    if (!file || file.status !== "READY") {
      gone.push(mention)
      continue
    }
    if (file.kind === "IMAGE") {
      if (images < limits.maxImages) {
        images++
        plans.push({ file, as: "image" })
      } else plans.push({ file, as: "note", why: `not shown: this turn already shows ${limits.maxImages} photos. room_files read shows it` })
    } else if (file.kind === "PDF") {
      const pages = file.pageCount ?? 0
      if (!pdfFitsAsDocument(file)) {
        plans.push({ file, as: "text", why: file.pageCount && file.pageCount > MAX_DOCUMENT_PAGES ? `it's over ${MAX_DOCUMENT_PAGES} pages, so here's the start of its text` : "here's what could be read of it" })
      } else if (pdfPages + pages > limits.maxPdfPages || pdfBytes + file.sizeBytes > limits.maxPdfBytes) {
        plans.push({ file, as: "text", why: `this turn's PDFs are over ${limits.maxPdfPages} pages or ${sizeLabel(limits.maxPdfBytes)}, so here's the start of its text` })
      } else {
        pdfPages += pages
        pdfBytes += file.sizeBytes
        plans.push({ file, as: "document" })
      }
    } else if (file.kind === "OTHER") plans.push({ file, as: "note", why: "it can't be shown" })
    else plans.push({ file, as: "summary" })
  }

  // Loading holds the reply up loadMs at most, and stops with the run
  const timeout = AbortSignal.timeout(limits.loadMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout

  // Claude Files copies for what goes as an image or a document: checked, or uploaded now if missing
  const sendIds = options.sendIds ?? claudeIdsReachModel()
  const client = !sendIds ? null : options.claude === undefined ? await claudeFilesForUploads() : options.claude
  const wanted = plans.filter((plan) => plan.as === "image" || plan.as === "document").map((plan) => plan.file)
  const ids = client && wanted.length ? await ensureClaudeIds(client, wanted, { store, signal }) : new Map<string, string>()

  // The model copies of photos that go inline, read at once; the inline cap is applied in order below
  const inline = plans.flatMap((plan) => (plan.as === "image" && !ids.has(plan.file.id) && plan.file.modelCopyPath ? [plan.file] : []))
  const copies = new Map(await Promise.all(inline.map(async (file) => [file.id, await readCopy(store, file.modelCopyPath!, signal)] as const)))

  const blocks: BetaContentBlockParam[] = []
  let inlineBytes = 0
  for (const plan of plans) {
    const { file } = plan
    const name = `File ${file.id}: ${JSON.stringify(shownName(file.filename))}`
    const claudeId = ids.get(file.id)
    if (plan.as === "image") {
      const size = file.width && file.height ? `, ${file.width}×${file.height}` : ""
      if (claudeId) {
        blocks.push({ type: "text", text: `${name} (photo${size}):` }, { type: "image", source: { type: "file", file_id: claudeId } })
        continue
      }
      const copy = copies.get(file.id) ?? null
      if (copy && inlineBytes + copy.length <= limits.maxInlineBytes) {
        inlineBytes += copy.length
        blocks.push({ type: "text", text: `${name} (photo${size}):` }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: copy.toString("base64") } })
      } else {
        blocks.push({ type: "text", text: `${name} (photo${size}): not shown in this turn${copy ? " (too many photos at once)" : ""}. room_files read shows it.` })
      }
    } else if (plan.as === "document") {
      if (claudeId) {
        blocks.push({ type: "text", text: `${name} (PDF, ${file.pageCount} page${file.pageCount === 1 ? "" : "s"}):` }, { type: "document", source: { type: "file", file_id: claudeId }, title: shownName(file.filename) })
      } else {
        blocks.push(textBlock(file, "here's its text", limits.pdfTextChars))
      }
    } else if (plan.as === "text") {
      blocks.push(textBlock(file, plan.why!, limits.pdfTextChars))
    } else if (plan.as === "summary") {
      blocks.push(textBlock(file, null, limits.summaryChars))
    } else {
      blocks.push({ type: "text", text: `${name} (${FILE_KIND_LABEL[file.kind]}, ${sizeLabel(file.sizeBytes)}): ${plan.why}.` })
    }
  }
  if (gone.length) blocks.push({ type: "text", text: `(No longer available: ${gone.map((file) => `${JSON.stringify(shownName(file.filename))} (id ${file.id})`).join(", ")}.)` })
  return blocks
}

/** A stored copy; null when it's missing or can't be read, or when the signal stops the wait first */
function readCopy(store: JackFileStore, path: string, signal: AbortSignal): Promise<Buffer | null> {
  if (signal.aborted) return Promise.resolve(null)
  return new Promise((resolve) => {
    const stop = () => resolve(null)
    signal.addEventListener("abort", stop, { once: true })
    store
      .get(path)
      .then(resolve, () => resolve(null))
      .finally(() => signal.removeEventListener("abort", stop))
  })
}

/**
 * A file's text, summarized, in tags that mark where it starts and ends: what's inside is the file's,
 * not anyone's instructions. Its links are neutralized (describe.ts says why), its name's too, and a
 * closing tag inside it can't end it early
 */
function textBlock(file: TurnFile, why: string | null, maxChars: number): BetaContentBlockParam {
  const summary = fileSummary(file, maxChars).replace(/<(\/?)attached_file/gi, "‹$1attached_file")
  const total = file.text?.length ?? 0
  const rest = total ? `\n(room_files read with this id${file.kind === "PDF" ? " and textOnly" : ""} gives all ${total.toLocaleString("en-US")} characters, a page at a time.)` : ""
  const attrs = `id="${file.id}" name=${JSON.stringify(shownName(file.filename).replace(/[<>]/g, ""))} kind="${FILE_KIND_LABEL[file.kind]}" size="${sizeLabel(file.sizeBytes)}"`
  return { type: "text", text: `<attached_file ${attrs}>\n${why ? `(${capitalize(why)}.)\n` : ""}${summary}${rest}\n</attached_file>` }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
