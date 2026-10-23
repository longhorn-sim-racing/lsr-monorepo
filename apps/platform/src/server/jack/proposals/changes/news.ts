import { z } from "zod"
import { slugify } from "@/lib/slug"
import { prisma } from "@/server/db"
import { uniqueSlug } from "@/server/jack/tools/draft-event"
import { CLUB_TZ } from "@/server/jack/tools/time"
import * as news from "@/server/services/news.service"
import { ProposalInputError, StaleProposalError } from "../errors"
import { applyTextEdits, textEditsSchema } from "../text-edits"
import type { ProposalDiffRow, ProposalKind, ProposalLink } from "../types"
import { markdownPreview, mdxError, parseMarkdown } from "./markdown"
import { fromLocal, LOCAL_TIME, listed, plural, revalidate, when } from "./shared"

/**
 * news.create and news.update (design §4.3): news posts, saved through the same news service as the
 * admin form (src/server/services/news.service.ts). Markdown only: the site renders a post's text as
 * MDX, so text with "<", "{", "}" outside code, or an import/export line, is refused (./markdown.ts)
 * with a message the model can fix. The card shows the post rendered as the site structures it, and a
 * line diff of the text for an edit. Publishing: a draft (only officers see it), scheduled for a time, or
 * published now (the time it's applied).
 */

export const NEWS_TITLE_MAX = 200
export const NEWS_EXCERPT_MAX = 300
export const NEWS_BODY_MAX = 50_000
const NEWS_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const slug = z.string().trim().max(100).regex(NEWS_SLUG, "A slug is lowercase letters, numbers and single hyphens, like lsc-season-3-kicks-off")
const tags = z.array(z.string().trim().min(1).max(40)).max(10)
const author = z.string().trim().min(1).max(80).describe("A handle (default: the officer who asked)")
const publish = z.enum(["draft", "schedule", "now"])
const publishAt = z.string().trim().regex(LOCAL_TIME, "Use Central local time like 2026-10-19T18:00").describe("With schedule: Central local time")
const body = z.string().trim().min(1).max(NEWS_BODY_MAX)

export const newsCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(NEWS_TITLE_MAX),
    bodyMd: body.describe("Markdown"),
    excerpt: z.string().trim().max(NEWS_EXCERPT_MAX).optional().describe("For the news page and link previews"),
    slug: slug.optional().describe("The link /news/<slug> (default: from the title)"),
    tags: tags.optional(),
    author: author.optional(),
    publish: publish.optional().describe("draft (default), schedule (at publishAt) or now (when applied)"),
    publishAt: publishAt.optional(),
  })
  .refine((p) => (p.publish === "schedule") === (p.publishAt !== undefined), { message: "publish schedule needs publishAt, and publishAt goes only with schedule.", path: ["publishAt"] })

export type NewsCreate = z.infer<typeof newsCreateSchema>

export const newsUpdateSchema = z
  .object({
    postId: z.string().trim().min(1).max(64).describe("Post.id"),
    title: z.string().trim().min(1).max(NEWS_TITLE_MAX).optional(),
    edits: textEditsSchema.optional().describe("Edits to bodyMd, applied in order"),
    bodyMd: body.optional().describe("The whole new text, for a rewrite"),
    excerpt: z.string().trim().max(NEWS_EXCERPT_MAX).optional().describe("Empty removes it"),
    slug: slug.optional().describe("A new link /news/<slug>"),
    tags: tags.optional().describe("Replaces the tags"),
    author: author.optional(),
    publish: publish.optional().describe("draft unpublishes it, schedule (at publishAt), now (when applied)"),
    publishAt: publishAt.optional(),
  })
  .refine((p) => p.edits === undefined || p.bodyMd === undefined, { message: "Give edits or a whole new bodyMd, not both.", path: ["bodyMd"] })
  .refine((p) => (p.publish === "schedule") === (p.publishAt !== undefined), { message: "publish schedule needs publishAt, and publishAt goes only with schedule.", path: ["publishAt"] })
  .refine((p) => Object.entries(p).some(([key, value]) => key !== "postId" && value !== undefined), { message: "Give at least one change." })

export type NewsUpdate = z.infer<typeof newsUpdateSchema>

/** A post's fields as the proposal saves them: the publish time as an ISO string ("now": when it's applied) */
type PostState = {
  title: string
  slug: string
  excerpt: string | null
  bodyMd: string
  authorId: string | null
  publishedAt: string | null
  tags: string[]
}
type PostField = keyof PostState

const FIELD_LABEL: Record<PostField, string> = { title: "Title", slug: "Link", excerpt: "Excerpt", bodyMd: "Text", authorId: "Author", publishedAt: "Publishing", tags: "Tags" }

const NOW = "now"

function checkBody(text: string, what = "The post's text") {
  const tree = parseMarkdown(text)
  const problem = mdxError(text, what, tree)
  if (problem) throw new ProposalInputError(problem)
  return tree
}

/** Tags without repeats (case-insensitive), as written first */
function cleanTags(list: string[]): string[] {
  const seen = new Set<string>()
  return list.filter((tag) => {
    const key = tag.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function findAuthor(handle: string | undefined, fallback: string | null): Promise<{ id: string; displayName: string }> {
  if (handle) {
    const user = await prisma.user.findFirst({ where: { handle: { equals: handle.replace(/^@/, ""), mode: "insensitive" }, status: { not: "deleted" } }, select: { id: true, displayName: true } })
    if (!user) throw new ProposalInputError(`No member has the handle @${handle.replace(/^@/, "")}. Find it with club_members.`)
    return user
  }
  if (fallback) {
    const user = await prisma.user.findUnique({ where: { id: fallback }, select: { id: true, displayName: true } })
    if (user) return user
  }
  throw new ProposalInputError("Say who the post is by: give the author's handle.")
}

async function authorName(id: string | null): Promise<string | null> {
  if (!id) return null
  const user = await prisma.user.findUnique({ where: { id }, select: { displayName: true } })
  return user?.displayName ?? "Former member"
}

/** The publish time a choice sets: "now" (the moment it's applied), a time, or null for a draft */
function publishValue(choice: "draft" | "schedule" | "now", at: string | undefined, now: Date): string | null {
  if (choice === "draft") return null
  if (choice === "now") return NOW
  const date = fromLocal(at ?? "", CLUB_TZ)
  if (!date) throw new ProposalInputError(`publishAt: ${at} isn't a time on the calendar.`)
  if (date <= now) throw new ProposalInputError(`publishAt (${when(date)}) has passed. Use publish now to publish it right away.`)
  return date.toISOString()
}

function publishing(value: string | null, now = new Date()): string {
  if (value === NOW) return "Published when applied"
  if (!value) return "Draft (only officers see it)"
  const date = new Date(value)
  return date > now ? `Scheduled for ${when(date)}` : `Published ${when(date)}`
}

function publishSentence(value: string | null, slugValue: string): string {
  if (value === NOW) return `It goes live at /news/${slugValue} as soon as it's applied, on the news page and in the RSS feed.`
  if (!value) return `It stays a draft at /news/${slugValue}: only officers can see it until it's published.`
  return `It goes live at /news/${slugValue} ${when(new Date(value))}.`
}

function resolvePublished(value: string | null): Date | null {
  return value === NOW ? new Date() : value ? new Date(value) : null
}

async function slugOwner(value: string, exceptId?: string): Promise<{ id: string; title: string } | null> {
  return prisma.post.findFirst({ where: { slug: value, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true, title: true } })
}

/** A slug for a new post made from its title, with -2, -3… when it's taken (as draft_event does for events) */
async function freeSlug(title: string): Promise<string> {
  const base =
    slugify(title)
      .replace(/_/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80)
      .replace(/-$/, "") || "post"
  const taken = await prisma.post.findMany({ where: { slug: { startsWith: base } }, select: { slug: true } })
  return uniqueSlug(
    base,
    taken.map((p) => p.slug),
  )
}

function postLinks(post: { id?: string; slug: string }, published: boolean): ProposalLink[] {
  return [...(post.id ? [{ title: "Edit post", url: `/admin/news/${post.id}` }] : [{ title: "News", url: "/admin/news" }]), { title: published ? "Post" : "Preview (officers)", url: `/news/${post.slug}` }]
}

const createdBefore = z.object({ slug: z.string(), authorId: z.string(), publishedAt: z.string().nullable() })

export const newsCreateKind: ProposalKind<NewsCreate> = {
  kind: "news.create",
  tool: "propose_content",
  description:
    "news.create: a new news post. Markdown only: the site renders posts as MDX, so no HTML and no < or { } outside `code` (links as [text](https://…)). It's a draft unless the officer asked to schedule it or publish it now. The author is the officer who asked unless they name someone (author: a handle). The card shows the post rendered.",
  schema: newsCreateSchema,
  targetType: "POST",
  permission: "officer",

  async prepare(p, ctx) {
    const tree = checkBody(p.bodyMd)
    const now = new Date()
    const writer = await findAuthor(p.author, ctx.officer.userId)
    let slugValue = p.slug
    if (slugValue) {
      const owner = await slugOwner(slugValue)
      if (owner) throw new ProposalInputError(`/news/${slugValue} is taken by “${owner.title}”. Pick another slug, or leave it out to make one from the title.`)
    } else slugValue = await freeSlug(p.title)
    const publishedAt = publishValue(p.publish ?? "draft", p.publishAt, now)
    const tagList = cleanTags(p.tags ?? [])
    // Words with a letter or digit in them, so Markdown's marks ("##", "-") don't count
    const words = p.bodyMd.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length

    const verb = !publishedAt ? "Draft" : publishedAt === NOW ? "Publish" : "Schedule"
    const summary = [`Applying it saves a news post by ${writer.displayName} (${plural(words, "word")}).`, publishSentence(publishedAt, slugValue), tagList.length ? `Tagged ${listed(tagList)}.` : null].filter(Boolean).join(" ")
    return {
      before: { slug: slugValue, authorId: writer.id, publishedAt },
      // A newer proposal for the same post (by its link) replaces this one
      targetId: `new:${slugValue}`,
      view: {
        title: `${verb} a news post: “${p.title}”`,
        summary,
        diff: [],
        links: [{ title: "News", url: "/admin/news" }],
        preview: markdownPreview(p.bodyMd, { label: "How the post reads", title: p.title, ...(p.excerpt ? { excerpt: p.excerpt } : {}) }, tree),
      },
    }
  },

  async checkStale(_p, before) {
    const saved = createdBefore.safeParse(before)
    if (!saved.success) return "The proposal's copy of the post is missing. Ask Jack to propose it again."
    const owner = await slugOwner(saved.data.slug)
    if (owner) return `The link /news/${saved.data.slug} was taken since this was proposed (by “${owner.title}”).`
    if (!(await prisma.user.findUnique({ where: { id: saved.data.authorId }, select: { id: true } }))) return "The author's account is gone."
    const at = saved.data.publishedAt
    if (at && at !== NOW && new Date(at) <= new Date()) return `Its publish time (${when(new Date(at))}) has passed.`
    return null
  },

  async apply(p, ctx) {
    const saved = createdBefore.safeParse(ctx.before)
    if (!saved.success) throw new StaleProposalError("The proposal's copy of the post is missing. Ask Jack to propose it again.")
    const publishedAt = resolvePublished(saved.data.publishedAt)
    const result = await news.createPost(
      { title: p.title, slug: saved.data.slug, excerpt: p.excerpt || undefined, coverImageUrl: null, bodyMd: p.bodyMd, authorId: saved.data.authorId, publishedAt, tags: cleanTags(p.tags ?? []) },
      { userId: ctx.officer.userId, auditMetadata: ctx.auditMetadata },
    )
    if (!result.ok) {
      if (result.error === "Slug already exists") throw new StaleProposalError(`The link /news/${saved.data.slug} was taken since this was proposed.`)
      throw new Error(result.error)
    }
    revalidate(result.revalidate)
    const live = Boolean(publishedAt && publishedAt <= new Date())
    const done = !publishedAt ? "Saved the draft" : live ? "Published" : `Scheduled (${when(publishedAt)})`
    return { summary: `${done}: news post “${result.post.title}”.`, links: postLinks(result.post, live), created: [{ type: "POST", id: result.post.id }] }
  },
}

async function loadPost(postId: string): Promise<(PostState & { id: string }) | null> {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true, title: true, slug: true, excerpt: true, bodyMd: true, authorId: true, publishedAt: true, coverImageUrl: true } })
  if (!post) return null
  const tagRows = await prisma.entityTag.findMany({ where: { entityType: "post", entityId: post.id }, select: { tag: { select: { name: true } } } })
  return {
    id: post.id,
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt || null,
    bodyMd: post.bodyMd,
    authorId: post.authorId,
    publishedAt: post.publishedAt?.toISOString() ?? null,
    tags: tagRows.map((row) => row.tag.name),
  }
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

const updateBefore = z.object({
  current: z.record(z.string(), z.unknown()),
  next: z.record(z.string(), z.unknown()),
})
type UpdateBefore = { current: Partial<PostState>; next: Partial<PostState> }

/** What the post's touched fields would become; throws ProposalInputError when the edits can't apply or nothing changes */
async function planUpdate(p: NewsUpdate, post: PostState & { id: string }, now: Date): Promise<UpdateBefore & { authorName?: string }> {
  const wanted: Partial<PostState> = {}
  if (p.title !== undefined) wanted.title = p.title
  if (p.slug !== undefined) wanted.slug = p.slug
  if (p.excerpt !== undefined) wanted.excerpt = p.excerpt || null
  if (p.edits) {
    const edited = applyTextEdits(post.bodyMd, p.edits, "the post's text")
    if ("error" in edited) throw new ProposalInputError(edited.error)
    if (edited.text.length > NEWS_BODY_MAX) throw new ProposalInputError(`With these edits the post would be ${edited.text.length.toLocaleString("en-US")} characters; posts hold at most ${NEWS_BODY_MAX.toLocaleString("en-US")}.`)
    wanted.bodyMd = edited.text
  }
  if (p.bodyMd !== undefined) wanted.bodyMd = p.bodyMd
  if (p.tags !== undefined) wanted.tags = cleanTags(p.tags)
  let authorDisplay: string | undefined
  if (p.author !== undefined) {
    const writer = await findAuthor(p.author, null)
    wanted.authorId = writer.id
    authorDisplay = writer.displayName
  }
  if (p.publish !== undefined) {
    const value = publishValue(p.publish, p.publishAt, now)
    const live = post.publishedAt !== null && new Date(post.publishedAt) <= now
    // Publishing a post that's already live keeps its date; a draft stays a draft
    if (!(value === NOW && live)) wanted.publishedAt = value
  }

  const next: Partial<PostState> = {}
  const current: Partial<PostState> = {}
  for (const field of Object.keys(wanted) as PostField[]) {
    if (sameValue(post[field], wanted[field])) continue
    ;(next as Record<string, unknown>)[field] = wanted[field]
    ;(current as Record<string, unknown>)[field] = post[field]
  }
  if (!Object.keys(next).length) throw new ProposalInputError(`Nothing would change: the post “${post.title}” already reads that way.`)
  if (next.bodyMd !== undefined) checkBody(next.bodyMd)
  if (next.slug !== undefined) {
    const owner = await slugOwner(next.slug, post.id)
    if (owner) throw new ProposalInputError(`/news/${next.slug} is taken by “${owner.title}”. Pick another slug.`)
  }
  return { current, next, ...(authorDisplay ? { authorName: authorDisplay } : {}) }
}

export const newsUpdateKind: ProposalKind<NewsUpdate> = {
  kind: "news.update",
  tool: "propose_content",
  description:
    'news.update: change a news post: its title, text, excerpt, link, tags, author, or publishing (back to draft, schedule, publish now). Read it first with run_sql (SELECT id, title, slug, "bodyMd", "publishedAt" FROM "Post"), and for small changes give exact find-and-replace edits copied from bodyMd (each must appear once; all or none apply); for a rewrite give the whole bodyMd. Markdown only, as for news.create.',
  schema: newsUpdateSchema,
  targetType: "POST",
  permission: "officer",

  async prepare(p) {
    const post = await loadPost(p.postId)
    if (!post) throw new ProposalInputError(`There's no news post with id ${p.postId}. Find it with run_sql: SELECT id, title, slug FROM "Post".`)
    const now = new Date()
    const plan = await planUpdate(p, post, now)
    const { current, next } = plan
    const after: PostState = { ...post, ...next }

    const display = async (field: PostField, state: Partial<PostState>, name?: string): Promise<string | null> => {
      const value = state[field]
      if (field === "authorId") return name ?? (await authorName((value as string | null) ?? null))
      if (field === "publishedAt") return publishing((value as string | null) ?? null, now)
      if (field === "slug") return `/news/${value}`
      if (field === "tags") return (value as string[]).length ? (value as string[]).join(", ") : null
      return (value as string | null) ?? null
    }
    const diff: ProposalDiffRow[] = []
    for (const field of Object.keys(next) as PostField[]) {
      diff.push({
        field,
        label: FIELD_LABEL[field],
        before: await display(field, current),
        after: await display(field, next, plan.authorName),
        format: field === "bodyMd" ? "markdown" : field === "publishedAt" || field === "authorId" ? "value" : "text",
      })
    }
    const live = (value: string | null) => value === NOW || (value !== null && new Date(value) <= now)
    const sentences = [
      next.publishedAt !== undefined ? (next.publishedAt === null ? `It goes back to a draft: only officers can see it until it's published again.` : publishSentence(next.publishedAt, after.slug)) : null,
      next.slug !== undefined && live(post.publishedAt) ? `Links to /news/${post.slug} already shared stop working.` : null,
      // The form needs an author; the service saves every field
      !after.authorId ? "Its author's account is gone, so the officer who applies it becomes its author." : null,
    ].filter(Boolean)
    const showPreview = next.bodyMd !== undefined || next.title !== undefined || next.excerpt !== undefined
    return {
      before: { current, next } satisfies UpdateBefore,
      targetId: post.id,
      view: {
        title: `Edit the news post “${post.title}”`,
        summary: ["Applying it saves the changes below.", ...sentences].join(" "),
        diff,
        links: postLinks(post, live(post.publishedAt)),
        ...(showPreview ? { preview: markdownPreview(after.bodyMd, { label: "How the post reads after the change", title: after.title, ...(after.excerpt ? { excerpt: after.excerpt } : {}) }) } : {}),
      },
    }
  },

  async checkStale(p, before) {
    const saved = updateBefore.safeParse(before)
    if (!saved.success) return "The proposal's copy of the post is missing. Ask Jack to propose it again."
    const post = await loadPost(p.postId)
    if (!post) return "The post was deleted."
    for (const [field, was] of Object.entries(saved.data.current) as [PostField, unknown][]) {
      if (!sameValue(post[field], was)) return `The post's ${FIELD_LABEL[field].toLowerCase()} changed since this was proposed.`
    }
    const next = saved.data.next as Partial<PostState>
    if (typeof next.slug === "string" && (await slugOwner(next.slug, post.id))) return `The link /news/${next.slug} was taken since this was proposed.`
    if (typeof next.publishedAt === "string" && next.publishedAt !== NOW && new Date(next.publishedAt) <= new Date()) return `Its new publish time (${when(new Date(next.publishedAt))}) has passed.`
    return null
  },

  async apply(p, ctx) {
    const saved = updateBefore.safeParse(ctx.before)
    if (!saved.success) throw new StaleProposalError("The proposal's copy of the post is missing. Ask Jack to propose it again.")
    const post = await prisma.post.findUnique({ where: { id: p.postId }, select: { coverImageUrl: true } })
    const current = await loadPost(p.postId)
    if (!post || !current) throw new StaleProposalError("The post was deleted.")
    const next = saved.data.next as Partial<PostState>
    const merged: PostState = { ...current, ...next }
    const publishedAt = resolvePublished(merged.publishedAt)
    const result = await news.updatePost(
      p.postId,
      // Every field, as the admin form sends them: an empty excerpt is "", which clears it
      { title: merged.title, slug: merged.slug, excerpt: merged.excerpt ?? "", coverImageUrl: post.coverImageUrl, bodyMd: merged.bodyMd, authorId: merged.authorId ?? ctx.officer.userId, publishedAt, tags: merged.tags },
      { userId: ctx.officer.userId, auditMetadata: ctx.auditMetadata },
    )
    if (!result.ok) {
      if (result.error === "Slug already exists") throw new StaleProposalError(`The link /news/${merged.slug} was taken since this was proposed.`)
      if (result.error === "Post not found") throw new StaleProposalError("The post was deleted.")
      throw new Error(result.error)
    }
    revalidate(result.revalidate)
    const changed = (Object.keys(next) as PostField[]).map((field) => FIELD_LABEL[field].toLowerCase())
    return { summary: `Updated the news post “${result.post.title}”: ${listed(changed)}.`, links: postLinks(result.post, Boolean(publishedAt && publishedAt <= new Date())) }
  },
}
