import { z } from "zod"
import { PAGE_PUBLIC_PATHS } from "@/app/admin/pages/_components/public-paths"
import { prisma } from "@/server/db"
import { PAGE_BODY_MAX, PAGE_TITLE_MAX, updatePageContent } from "@/server/services/page.service"
import { ProposalInputError, StaleProposalError } from "./errors"
import { applyTextEdits, textEditsSchema } from "./text-edits"
import type { ProposalDiffRow, ProposalKind, ProposalLink } from "./types"

/**
 * page.update (design §4.3), the reference kind: a content page's title and/or exact find-and-replace
 * edits to its Markdown text, saved through the same page service as the admin form. `before` holds the
 * page's title and text as they were; it's stale if either changed, and the write itself only lands if
 * they still match (the service's `expected`), so an edit made in between is never overwritten.
 */

export const pageUpdateSchema = z
  .object({
    pageId: z.string().min(1).max(64).describe('The page\'s id (Page.id), from run_sql on "Page"'),
    title: z.string().trim().min(1).max(PAGE_TITLE_MAX).optional().describe("A new title; leave out to keep the current one"),
    edits: textEditsSchema.optional().describe("Exact find-and-replace edits to the page's Markdown text (bodyMd), applied in order"),
  })
  .refine((p) => p.title !== undefined || p.edits !== undefined, { message: "Give a new title, edits, or both." })

export type PageUpdate = z.infer<typeof pageUpdateSchema>

/** The page as it was when proposed: what checkStale compares and the write's condition */
const pageBefore = z.object({ title: z.string(), bodyMd: z.string() })
export type PageBefore = z.infer<typeof pageBefore>

type PageRow = { id: string; title: string; slug: string; bodyMd: string; visibility: string }

/** What would change: the new title and text, only where they differ. Throws ProposalInputError when the edits can't apply */
export function pageChanges(page: PageBefore, p: PageUpdate): { title?: string; bodyMd?: string } {
  const changes: { title?: string; bodyMd?: string } = {}
  if (p.title !== undefined && p.title !== page.title) changes.title = p.title
  if (p.edits) {
    const edited = applyTextEdits(page.bodyMd, p.edits, "the page's text")
    if ("error" in edited) throw new ProposalInputError(edited.error)
    if (edited.text.length > PAGE_BODY_MAX) throw new ProposalInputError(`With these edits the page would be ${edited.text.length.toLocaleString("en-US")} characters; pages hold at most ${PAGE_BODY_MAX.toLocaleString("en-US")}.`)
    if (edited.text !== page.bodyMd) changes.bodyMd = edited.text
  }
  if (changes.title === undefined && changes.bodyMd === undefined) throw new ProposalInputError("Nothing would change: the page already has this title and text.")
  return changes
}

function pageLinks(page: Pick<PageRow, "id" | "slug">, title = "Edit page"): ProposalLink[] {
  const path = PAGE_PUBLIC_PATHS[page.slug]
  return [{ title, url: `/admin/pages/${page.id}` }, ...(path ? [{ title: "Public page", url: path }] : [])]
}

function where(page: PageRow): string {
  const path = PAGE_PUBLIC_PATHS[page.slug]
  if (page.visibility !== "public") return "It's a draft, so only officers see it."
  return path ? `The site shows it at ${path}.` : "It's public, but the site doesn't link to it yet."
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`
}

export const pageUpdateKind: ProposalKind<PageUpdate> = {
  kind: "page.update",
  tool: "propose_change",
  description:
    'page.update: change a content page (admin Pages, such as the LSC rules): a new title, and/or exact find-and-replace edits to its Markdown text. First read the page with run_sql (SELECT id, title, slug, "bodyMd" FROM "Page"), and copy each find exactly from bodyMd, with enough around it to appear only once. Edits apply in order, all or none. It can\'t change a page\'s slug, or publish or unpublish it.',
  schema: pageUpdateSchema,
  targetType: "PAGE",
  permission: "officer",

  async prepare(p) {
    const page = await prisma.page.findUnique({ where: { id: p.pageId }, select: { id: true, title: true, slug: true, bodyMd: true, visibility: true } })
    if (!page) throw new ProposalInputError(`There's no page with id ${p.pageId}. Find it with run_sql: SELECT id, title, slug FROM "Page".`)
    const changes = pageChanges(page, p)

    const diff: ProposalDiffRow[] = []
    if (changes.title !== undefined) diff.push({ field: "title", label: "Title", before: page.title, after: changes.title, format: "text" })
    if (changes.bodyMd !== undefined) diff.push({ field: "bodyMd", label: "Text", before: page.bodyMd, after: changes.bodyMd, format: "markdown" })

    const edits = p.edits?.length ?? 0
    const what = [changes.bodyMd !== undefined ? `changes its text in ${plural(edits, "place")}` : null, changes.title !== undefined ? `renames it “${changes.title}”` : null].filter(Boolean).join(" and ")
    const title = changes.bodyMd === undefined ? `Rename the page “${page.title}”` : `Edit the page “${page.title}”`
    return {
      before: { title: page.title, bodyMd: page.bodyMd } satisfies PageBefore,
      targetId: page.id,
      view: { title, summary: `Applying it ${what}. ${where(page)}`, diff, links: pageLinks(page) },
    }
  },

  async checkStale(p, before) {
    const was = pageBefore.safeParse(before)
    if (!was.success) return "The proposal's copy of the page is missing. Ask Jack to propose it again."
    const page = await prisma.page.findUnique({ where: { id: p.pageId }, select: { title: true, bodyMd: true } })
    if (!page) return "The page was deleted."
    if (page.title !== was.data.title) return `The page's title changed since this was proposed (it's now “${page.title}”).`
    if (page.bodyMd !== was.data.bodyMd) return "Someone edited the page's text since this was proposed."
    return null
  },

  async apply(p, ctx) {
    const was = pageBefore.safeParse(ctx.before)
    if (!was.success) throw new StaleProposalError("The proposal's copy of the page is missing. Ask Jack to propose it again.")
    // Built from the page as it was proposed; the write only lands if the page still is exactly that
    const changes = pageChanges(was.data, p)
    const saved = await updatePageContent(p.pageId, changes, { actorUserId: ctx.officer.userId, expected: was.data, auditMetadata: ctx.auditMetadata })
    if (!saved.ok) {
      if (saved.reason === "changed") throw new StaleProposalError("Someone changed the page since this was proposed.")
      if (saved.reason === "not_found") throw new StaleProposalError("The page was deleted.")
      throw new Error(saved.error)
    }
    return { summary: `Updated the page “${saved.page.title}”.`, links: pageLinks(saved.page, saved.page.title) }
  },
}
