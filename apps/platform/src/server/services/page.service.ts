import { revalidatePath } from "next/cache"
import { z } from "zod"
import { Prisma, type Page } from "@prisma/client"
import { prisma } from "@/server/db"
import { createAuditLog } from "@/server/audit/log"
import { LSC_RULES_SLUG } from "@/lib/page-slugs"

/**
 * Content pages (Pages in the admin console, e.g. the LSC rules). The admin form (`savePage`) and Jack's
 * page.update proposals both save through here, so they share the checks, the audit entry and the
 * revalidation. Returns a result instead of throwing for anything an officer can fix.
 */

/** The site links to these by slug; renaming one would silently break the page and its links */
export const LOCKED_PAGE_SLUGS = [LSC_RULES_SLUG]

export const PAGE_TITLE_MAX = 200
export const PAGE_BODY_MAX = 50_000

export const pageSchema = z.object({
  title: z.string().trim().min(1, "Give the page a title.").max(PAGE_TITLE_MAX),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug: lowercase letters, numbers and dashes."),
  visibility: z.enum(["public", "officers"]),
  bodyMd: z.string().max(PAGE_BODY_MAX, "That's too long for one page."),
})

export type PageInput = z.infer<typeof pageSchema>

export type PageSaveResult =
  | { ok: true; page: Page; before: Page | null }
  | {
      ok: false
      error: string
      /** invalid: the input failed the checks. changed: the page no longer matches `expected` */
      reason: "invalid" | "not_found" | "locked_slug" | "slug_taken" | "changed" | "error"
    }

export type PageSaveOptions = {
  actorUserId: string
  /**
   * Save only if these fields are still exactly this (Jack's proposals: the page as it was when
   * proposed). Checked in the same statement as the update, so a save in between makes it "changed"
   */
  expected?: { title?: string; bodyMd?: string }
  /** Added to the audit entry, e.g. { via: "jack", proposalId } */
  auditMetadata?: Record<string, unknown>
}

/** Pages the site renders from these rows; every save refreshes them */
export function revalidatePagePaths() {
  revalidatePath("/admin/pages")
  revalidatePath("/lone-star-cup")
  revalidatePath("/lone-star-cup/rules")
}

export async function createPage(input: PageInput, { actorUserId, auditMetadata }: Omit<PageSaveOptions, "expected">): Promise<PageSaveResult> {
  const parsed = pageSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form.", reason: "invalid" }
  try {
    const page = await prisma.page.create({ data: { ...parsed.data, authorId: actorUserId } })
    await audit(null, page, actorUserId, auditMetadata)
    revalidatePagePaths()
    return { ok: true, page, before: null }
  } catch (error) {
    return failure(error)
  }
}

/**
 * Changes an existing page: any of its title, slug, visibility and body. The LSC rules page keeps its
 * slug. With `expected`, saves only if those fields haven't changed since (reason "changed" otherwise).
 */
export async function updatePageContent(pageId: string, changes: Partial<PageInput>, { actorUserId, expected, auditMetadata }: PageSaveOptions): Promise<PageSaveResult> {
  const parsed = pageSchema.partial().safeParse(changes)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form.", reason: "invalid" }
  const data = parsed.data

  try {
    const before = await prisma.page.findUnique({ where: { id: pageId } })
    if (!before) return { ok: false, error: "Page not found.", reason: "not_found" }
    if (LOCKED_PAGE_SLUGS.includes(before.slug) && data.slug !== undefined && data.slug !== before.slug) {
      return { ok: false, error: `The slug "${before.slug}" is used by the site and can't be changed.`, reason: "locked_slug" }
    }

    let page: Page
    if (expected) {
      // One conditional UPDATE: a save that lands between reading and writing makes this one miss
      const { count } = await prisma.page.updateMany({ where: { id: pageId, ...expected }, data: { ...data, authorId: actorUserId } })
      if (!count) return { ok: false, error: "The page changed since this was proposed.", reason: "changed" }
      page = await prisma.page.findUniqueOrThrow({ where: { id: pageId } })
    } else {
      page = await prisma.page.update({ where: { id: pageId }, data: { ...data, authorId: actorUserId } })
    }

    await audit(before, page, actorUserId, auditMetadata)
    revalidatePagePaths()
    return { ok: true, page, before }
  } catch (error) {
    return failure(error)
  }
}

async function audit(before: Page | null, page: Page, actorUserId: string, metadata?: Record<string, unknown>) {
  const published = before && before.visibility !== page.visibility ? ` (${page.visibility === "public" ? "published" : "unpublished"})` : ""
  await createAuditLog({
    actorUserId,
    actionType: before ? "UPDATE" : "CREATE",
    entityType: "PAGE",
    entityId: page.id,
    summary: `${before ? "Updated" : "Created"} page: ${page.title}${published}`,
    before: before ?? undefined,
    after: page,
    ...(metadata ? { metadata } : {}),
  })
}

function failure(error: unknown): PageSaveResult {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return { ok: false, error: "Another page already uses that slug.", reason: "slug_taken" }
  }
  return { ok: false, error: error instanceof Error ? error.message : "Couldn't save the page.", reason: "error" }
}
