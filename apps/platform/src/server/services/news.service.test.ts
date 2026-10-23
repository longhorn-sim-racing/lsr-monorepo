import { beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "@prisma/client"

// A stand-in for the Prisma client: only what the news service touches
const db = vi.hoisted(() => ({
  post: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
  tag: { findUnique: vi.fn(), create: vi.fn() },
  entityTag: { create: vi.fn(), deleteMany: vi.fn() },
}))
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))

vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/audit/log", () => audit)

import { createPost, updatePost } from "./news.service"
import type { NewsPostSchema } from "@/schemas/news.schema"

const officer = { userId: "officer-1" }
const viaJack = { userId: "officer-2", auditMetadata: { via: "jack", proposalId: "p1" } }

const post = (extra: Partial<NewsPostSchema> = {}): NewsPostSchema => ({
  title: "LSC Season 3 kicks off",
  slug: "lsc-season-3",
  excerpt: "Round 1 is Saturday",
  coverImageUrl: null,
  bodyMd: "Sign up on the **LSC page**.",
  authorId: "author-1",
  publishedAt: null,
  tags: [],
  ...extra,
})

const clash = () => new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" })
const saved = (data: object) => ({ id: "post-1", visibility: "public", createdAt: new Date(), updatedAt: new Date(), ...data })

beforeEach(() => {
  db.post.create.mockImplementation(async ({ data }: { data: object }) => saved(data))
  db.post.update.mockImplementation(async ({ data }: { data: object }) => saved(data))
  db.tag.findUnique.mockResolvedValue(null)
  db.tag.create.mockImplementation(async ({ data }: { data: { slug: string } }) => ({ id: `tag-${data.slug}`, ...data }))
})

describe("createPost", () => {
  it("saves the post, audits it and lists the pages to refresh", async () => {
    const publishedAt = new Date("2026-10-23T15:00:00Z")
    const result = await createPost(post({ publishedAt, coverImageUrl: undefined }), officer)

    expect(db.post.create).toHaveBeenCalledWith({
      data: {
        title: "LSC Season 3 kicks off",
        slug: "lsc-season-3",
        excerpt: "Round 1 is Saturday",
        coverImageUrl: null,
        bodyMd: "Sign up on the **LSC page**.",
        publishedAt,
        authorId: "author-1",
      },
    })
    expect(audit.createAuditLog).toHaveBeenCalledWith({
      actorUserId: "officer-1",
      actionType: "CREATE",
      entityType: "POST",
      entityId: "post-1",
      summary: "Created news post: LSC Season 3 kicks off",
      after: { title: "LSC Season 3 kicks off", slug: "lsc-season-3" },
      metadata: undefined,
    })
    expect(db.entityTag.create).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: true, post: { id: "post-1", slug: "lsc-season-3" }, revalidate: ["/admin/news", "/news"] })
  })

  it("tags the post, creating tags that don't exist yet", async () => {
    db.tag.findUnique.mockImplementation(async ({ where }: { where: { slug: string } }) => (where.slug === "lsc" ? { id: "tag-existing" } : null))

    await createPost(post({ tags: ["LSC", "Season Recap"] }), officer)

    expect(db.tag.create).toHaveBeenCalledTimes(1)
    expect(db.tag.create).toHaveBeenCalledWith({ data: { name: "Season Recap", slug: "season-recap" } })
    expect(db.entityTag.create.mock.calls.map(([args]) => args.data)).toEqual([
      { tagId: "tag-existing", entityType: "post", entityId: "post-1" },
      { tagId: "tag-season-recap", entityType: "post", entityId: "post-1" },
    ])
  })

  it("returns a taken slug or a failed save instead of throwing", async () => {
    db.post.create.mockRejectedValueOnce(clash())
    expect(await createPost(post(), officer)).toEqual({ ok: false, error: "Slug already exists" })

    db.post.create.mockRejectedValueOnce(new Error("connection lost"))
    expect(await createPost(post(), officer)).toEqual({ ok: false, error: "Failed to create post" })
  })

  it("keeps the post when tagging fails, and reports the failure (as the admin page always has)", async () => {
    db.entityTag.create.mockRejectedValue(new Error("connection lost"))
    expect(await createPost(post({ tags: ["LSC"] }), officer)).toEqual({ ok: false, error: "Failed to create post" })
    expect(db.post.create).toHaveBeenCalled()
  })

  it("returns a post that doesn't validate instead of throwing", async () => {
    const result = await createPost(post({ title: "", slug: "Not A Slug" }), officer)
    expect(result).toEqual({ ok: false, error: "Title is required. Slug must be lowercase, alphanumeric, and hyphenated" })
    expect(db.post.create).not.toHaveBeenCalled()
  })

  it("adds a proposal's ids to the audit entry", async () => {
    await createPost(post(), viaJack)
    expect(audit.createAuditLog.mock.calls[0][0]).toMatchObject({ actorUserId: "officer-2", metadata: { via: "jack", proposalId: "p1" } })
  })
})

describe("updatePost", () => {
  beforeEach(() => db.post.findUnique.mockResolvedValue(saved({ slug: "lsc-season-3" })))

  it("saves the post, replaces its tags, audits it and lists the pages to refresh", async () => {
    const result = await updatePost("post-1", post({ tags: ["LSC"] }), officer)

    expect(db.post.update).toHaveBeenCalledWith({
      where: { id: "post-1" },
      data: {
        title: "LSC Season 3 kicks off",
        slug: "lsc-season-3",
        excerpt: "Round 1 is Saturday",
        coverImageUrl: null,
        bodyMd: "Sign up on the **LSC page**.",
        publishedAt: null,
        authorId: "author-1",
      },
    })
    expect(audit.createAuditLog).toHaveBeenCalledWith({
      actorUserId: "officer-1",
      actionType: "UPDATE",
      entityType: "POST",
      entityId: "post-1",
      summary: "Updated news post: LSC Season 3 kicks off",
      after: { title: "LSC Season 3 kicks off", slug: "lsc-season-3" },
      metadata: undefined,
    })
    expect(db.entityTag.deleteMany).toHaveBeenCalledWith({ where: { entityType: "post", entityId: "post-1" } })
    expect(db.entityTag.create).toHaveBeenCalledWith({ data: { tagId: "tag-lsc", entityType: "post", entityId: "post-1" } })
    expect(result).toMatchObject({ ok: true, revalidate: ["/admin/news", "/news", "/news/lsc-season-3"] })
  })

  it("refreshes the old address too when the slug changes", async () => {
    const result = await updatePost("post-1", post({ slug: "season-3-kickoff" }), officer)
    expect(result).toMatchObject({ ok: true, revalidate: ["/admin/news", "/news", "/news/lsc-season-3", "/news/season-3-kickoff"] })
  })

  it("clears the tags when none are picked", async () => {
    await updatePost("post-1", post({ tags: [] }), officer)
    expect(db.entityTag.deleteMany).toHaveBeenCalled()
    expect(db.entityTag.create).not.toHaveBeenCalled()
  })

  it("says so when the post is gone", async () => {
    db.post.findUnique.mockResolvedValue(null)
    expect(await updatePost("post-1", post(), officer)).toEqual({ ok: false, error: "Post not found" })
    expect(db.post.update).not.toHaveBeenCalled()
  })

  it("returns a taken slug or a failed save instead of throwing", async () => {
    db.post.update.mockRejectedValueOnce(clash())
    expect(await updatePost("post-1", post(), officer)).toEqual({ ok: false, error: "Slug already exists" })

    db.post.update.mockRejectedValueOnce(new Error("connection lost"))
    expect(await updatePost("post-1", post(), officer)).toEqual({ ok: false, error: "Failed to update post" })
  })

  it("returns a post that doesn't validate instead of throwing", async () => {
    expect(await updatePost("post-1", post({ bodyMd: "" }), officer)).toEqual({ ok: false, error: "Content is required" })
    expect(db.post.findUnique).not.toHaveBeenCalled()
  })
})
