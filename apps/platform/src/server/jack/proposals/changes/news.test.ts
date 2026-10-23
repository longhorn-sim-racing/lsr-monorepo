import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  post: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  user: { findFirst: vi.fn(), findUnique: vi.fn() },
  entityTag: { findMany: vi.fn() },
}))
const news = vi.hoisted(() => ({ createPost: vi.fn(), updatePost: vi.fn() }))
const cache = vi.hoisted(() => ({ revalidatePaths: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/services/news.service", () => news)
vi.mock("@/server/cache/revalidate-public", () => cache)

import { ProposalInputError, StaleProposalError } from "../errors"
import type { ProposalApplyContext, ProposalContext } from "../types"
import { newsCreateKind, newsCreateSchema, newsUpdateKind, newsUpdateSchema, type NewsCreate, type NewsUpdate } from "./news"

const ctx: ProposalContext = { roomId: "room-1", messageId: "reply-1", officer: { userId: "u1", displayName: "Ana" } }
const audit = { via: "jack" as const, proposalId: "prop-1", roomId: "room-1", proposedFor: "u1" }
const applyCtx = (before: unknown): ProposalApplyContext => ({ officer: { userId: "u2", displayName: "Gray" }, proposalId: "prop-1", roomId: "room-1", idempotencyKey: "proposal:prop-1", before, auditMetadata: audit })
const actor = { userId: "u2", auditMetadata: audit }

const BODY = "## Round 3 recap\n\nWhat a race at **Spa**.\n\n- Win: Ana\n- Fastest lap: Ben"
const create = (p: Record<string, unknown>) => newsCreateSchema.parse({ title: "Round 3 at Spa", bodyMd: BODY, ...p }) as NewsCreate
const update = (p: Record<string, unknown>) => newsUpdateSchema.parse({ postId: "post-1", ...p }) as NewsUpdate

const POST = {
  id: "post-1",
  title: "Round 3 at Spa",
  slug: "round-3-at-spa",
  excerpt: "A recap",
  bodyMd: BODY,
  authorId: "u1",
  publishedAt: new Date("2026-10-20T15:00:00Z"),
  coverImageUrl: "https://res.cloudinary.com/lsr/image/upload/spa.jpg",
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-10-22T17:00:00Z"))
  db.post.findFirst.mockResolvedValue(null)
  db.post.findMany.mockResolvedValue([])
  db.post.findUnique.mockResolvedValue(POST)
  db.user.findFirst.mockResolvedValue({ id: "u3", displayName: "Dylan" })
  db.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id, displayName: where.id === "u1" ? "Ana" : "Someone" }))
  db.entityTag.findMany.mockResolvedValue([{ tag: { name: "LSC" } }])
  news.createPost.mockResolvedValue({ ok: true, post: { id: "post-9", slug: "round-3-at-spa", title: "Round 3 at Spa" }, revalidate: ["/admin/news", "/news"] })
  news.updatePost.mockResolvedValue({ ok: true, post: { id: "post-1", slug: "round-3-at-spa", title: "Round 3 at Spa" }, revalidate: ["/admin/news", "/news", "/news/round-3-at-spa"] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe("news.create", () => {
  it("saves a draft by the officer who asked, with a rendered preview", async () => {
    const prepared = await newsCreateKind.prepare(create({ tags: ["LSC", "lsc", "Results"] }), ctx)
    expect(prepared.before).toEqual({ slug: "round-3-at-spa", authorId: "u1", publishedAt: null })
    expect(prepared.targetId).toBe("new:round-3-at-spa")
    expect(prepared.view.title).toBe("Draft a news post: “Round 3 at Spa”")
    expect(prepared.view.summary).toBe("Applying it saves a news post by Ana (13 words). It stays a draft at /news/round-3-at-spa: only officers can see it until it's published. Tagged LSC and Results.")
    expect(prepared.view.preview).toMatchObject({ label: "How the post reads", title: "Round 3 at Spa", blocks: [{ t: "h", depth: 2 }, { t: "p" }, { t: "list", ordered: false }] })
  })

  it("refuses HTML and MDX with a message the model can fix", async () => {
    const error = await newsCreateKind.prepare(create({ bodyMd: "Come <b>now</b>" }), ctx).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProposalInputError)
    expect((error as Error).message).toMatch(/^The post's text must be plain Markdown: .*line 1 has "<"/)
  })

  it("picks a free link from the title, and refuses a taken one it was given", async () => {
    db.post.findMany.mockResolvedValue([{ slug: "round-3-at-spa" }, { slug: "round-3-at-spa-2" }])
    expect((await newsCreateKind.prepare(create({}), ctx)).before).toMatchObject({ slug: "round-3-at-spa-3" })
    db.post.findFirst.mockResolvedValue({ id: "p0", title: "Old post" })
    await expect(newsCreateKind.prepare(create({ slug: "round-3" }), ctx)).rejects.toThrow("/news/round-3 is taken by “Old post”.")
  })

  it("takes another author by handle, and needs one outside a room reply", async () => {
    const prepared = await newsCreateKind.prepare(create({ author: "@dylan" }), ctx)
    expect(db.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { handle: { equals: "dylan", mode: "insensitive" }, status: { not: "deleted" } } }))
    expect(prepared.before).toMatchObject({ authorId: "u3" })
    db.user.findFirst.mockResolvedValue(null)
    await expect(newsCreateKind.prepare(create({ author: "nobody" }), ctx)).rejects.toThrow("No member has the handle @nobody.")
    await expect(newsCreateKind.prepare(create({}), { ...ctx, officer: { userId: null, displayName: "Jack" } })).rejects.toThrow("Say who the post is by")
  })

  it("schedules for a future time and publishes now when asked", async () => {
    const scheduled = await newsCreateKind.prepare(create({ publish: "schedule", publishAt: "2026-10-26T10:00" }), ctx)
    expect(scheduled.before).toMatchObject({ publishedAt: "2026-10-26T15:00:00.000Z" })
    expect(scheduled.view.summary).toContain("It goes live at /news/round-3-at-spa Mon Oct 26, 10:00 AM CT.")
    const now = await newsCreateKind.prepare(create({ publish: "now" }), ctx)
    expect(now.view.title).toBe("Publish a news post: “Round 3 at Spa”")
    await expect(newsCreateKind.prepare(create({ publish: "schedule", publishAt: "2026-10-21T10:00" }), ctx)).rejects.toThrow(/has passed/)
    expect(newsCreateSchema.safeParse({ title: "x", bodyMd: "y", publish: "schedule" }).success).toBe(false)
  })

  it("creates the post through the news service, publishing at apply time", async () => {
    const p = create({ excerpt: "Spa recap", publish: "now", tags: ["LSC"] })
    const result = await newsCreateKind.apply(p, applyCtx({ slug: "round-3-at-spa", authorId: "u1", publishedAt: "now" }))
    expect(news.createPost).toHaveBeenCalledWith(
      { title: "Round 3 at Spa", slug: "round-3-at-spa", excerpt: "Spa recap", coverImageUrl: null, bodyMd: BODY, authorId: "u1", publishedAt: new Date("2026-10-22T17:00:00Z"), tags: ["LSC"] },
      actor,
    )
    expect(cache.revalidatePaths).toHaveBeenCalledWith(["/admin/news", "/news"])
    expect(result).toEqual({
      summary: "Published: news post “Round 3 at Spa”.",
      links: [
        { title: "Edit post", url: "/admin/news/post-9" },
        { title: "Post", url: "/news/round-3-at-spa" },
      ],
      created: [{ type: "POST", id: "post-9" }],
    })
  })

  it("goes stale when its link was taken or its time passed", async () => {
    const before = { slug: "round-3-at-spa", authorId: "u1", publishedAt: "2026-10-26T15:00:00.000Z" }
    expect(await newsCreateKind.checkStale(create({}), before)).toBeNull()
    vi.setSystemTime(new Date("2026-10-27T00:00:00Z"))
    expect(await newsCreateKind.checkStale(create({}), before)).toMatch(/publish time .* has passed/)
    db.post.findFirst.mockResolvedValue({ id: "p0", title: "Someone else's" })
    expect(await newsCreateKind.checkStale(create({}), before)).toMatch(/was taken since this was proposed/)
    news.createPost.mockResolvedValue({ ok: false, error: "Slug already exists" })
    await expect(newsCreateKind.apply(create({}), applyCtx(before))).rejects.toBeInstanceOf(StaleProposalError)
  })
})

describe("news.update", () => {
  it("edits the text as a line diff with the post rendered as it would read", async () => {
    const prepared = await newsUpdateKind.prepare(update({ edits: [{ find: "Fastest lap: Ben", replace: "Fastest lap: Carla" }] }), ctx)
    expect(prepared.targetId).toBe("post-1")
    expect(prepared.before).toEqual({ current: { bodyMd: BODY }, next: { bodyMd: BODY.replace("Ben", "Carla") } })
    expect(prepared.view.diff).toEqual([{ field: "bodyMd", label: "Text", before: BODY, after: BODY.replace("Ben", "Carla"), format: "markdown" }])
    expect(prepared.view.preview).toMatchObject({ label: "How the post reads after the change", title: "Round 3 at Spa", excerpt: "A recap" })
    expect(prepared.view.title).toBe("Edit the news post “Round 3 at Spa”")
  })

  it("unpublishes, renames and retags, warning that shared links break", async () => {
    const prepared = await newsUpdateKind.prepare(update({ slug: "spa-recap", tags: ["LSC", "Spa"], publish: "draft" }), ctx)
    expect(prepared.view.diff).toEqual([
      { field: "slug", label: "Link", before: "/news/round-3-at-spa", after: "/news/spa-recap", format: "text" },
      { field: "tags", label: "Tags", before: "LSC", after: "LSC, Spa", format: "text" },
      { field: "publishedAt", label: "Publishing", before: "Published Tue Oct 20, 10:00 AM CT", after: "Draft (only officers see it)", format: "value" },
    ])
    expect(prepared.view.summary).toBe("Applying it saves the changes below. It goes back to a draft: only officers can see it until it's published again. Links to /news/round-3-at-spa already shared stop working.")
    expect(prepared.view.preview).toBeUndefined()
  })

  it("refuses edits that don't apply, MDX, a taken link and changes that change nothing", async () => {
    await expect(newsUpdateKind.prepare(update({ edits: [{ find: "Monza", replace: "Imola" }] }), ctx)).rejects.toThrow(/the find text isn't in the post's text/)
    await expect(newsUpdateKind.prepare(update({ bodyMd: "Now with {props}" }), ctx)).rejects.toThrow(/must be plain Markdown/)
    await expect(newsUpdateKind.prepare(update({ title: "Round 3 at Spa", publish: "now" }), ctx)).rejects.toThrow("Nothing would change")
    db.post.findFirst.mockResolvedValue({ id: "p0", title: "Other" })
    await expect(newsUpdateKind.prepare(update({ slug: "taken" }), ctx)).rejects.toThrow("/news/taken is taken by “Other”.")
    db.post.findUnique.mockResolvedValue(null)
    await expect(newsUpdateKind.prepare(update({ title: "x" }), ctx)).rejects.toThrow(/There's no news post with id post-1/)
    expect(newsUpdateSchema.safeParse({ postId: "p", edits: [{ find: "a", replace: "b" }], bodyMd: "c" }).success).toBe(false)
  })

  it("goes stale when a field it changes moved", async () => {
    const p = update({ title: "Spa!" })
    const { before } = await newsUpdateKind.prepare(p, ctx)
    expect(await newsUpdateKind.checkStale(p, before)).toBeNull()
    db.post.findUnique.mockResolvedValue({ ...POST, title: "Renamed" })
    expect(await newsUpdateKind.checkStale(p, before)).toBe("The post's title changed since this was proposed.")
    db.post.findUnique.mockResolvedValue(null)
    expect(await newsUpdateKind.checkStale(p, before)).toBe("The post was deleted.")
  })

  it("saves every field through the news service, the untouched ones as they are now", async () => {
    const p = update({ excerpt: "", title: "Spa!" })
    const { before } = await newsUpdateKind.prepare(p, ctx)
    const result = await newsUpdateKind.apply(p, applyCtx(before))
    expect(news.updatePost).toHaveBeenCalledWith(
      "post-1",
      { title: "Spa!", slug: "round-3-at-spa", excerpt: "", coverImageUrl: POST.coverImageUrl, bodyMd: BODY, authorId: "u1", publishedAt: POST.publishedAt, tags: ["LSC"] },
      actor,
    )
    expect(result.summary).toBe("Updated the news post “Round 3 at Spa”: title and excerpt.")
    news.updatePost.mockResolvedValue({ ok: false, error: "Post not found" })
    await expect(newsUpdateKind.apply(p, applyCtx(before))).rejects.toThrow("The post was deleted.")
  })
})
