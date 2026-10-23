import { beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "@prisma/client"

// The actions run for real on top of the news service; only Prisma, the guard, the session and Next are fakes
const db = vi.hoisted(() => ({
  post: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
  tag: { findUnique: vi.fn(), create: vi.fn() },
  entityTag: { create: vi.fn(), deleteMany: vi.fn() },
}))
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))
const next = vi.hoisted(() => ({ revalidatePath: vi.fn() }))
const auth = vi.hoisted(() => ({ requireRole: vi.fn(), getSessionUser: vi.fn() }))

vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/audit/log", () => audit)
vi.mock("@/server/auth/guards", () => ({ requireRole: auth.requireRole }))
vi.mock("@/server/auth/session", () => ({ getSessionUser: auth.getSessionUser }))
vi.mock("next/cache", () => ({ revalidatePath: next.revalidatePath }))

import { createPost, updatePost } from "./news"
import type { NewsPostSchema } from "@/schemas/news.schema"

const post = (extra: Partial<NewsPostSchema> = {}): NewsPostSchema => ({
  title: "LSC Season 3 kicks off",
  slug: "lsc-season-3",
  excerpt: "",
  coverImageUrl: null,
  bodyMd: "Sign up on the LSC page.",
  authorId: "author-1",
  publishedAt: null,
  tags: [],
  ...extra,
})

const revalidated = () => next.revalidatePath.mock.calls.map(([path]) => path)

beforeEach(() => {
  auth.requireRole.mockResolvedValue({ id: "officer-1" })
  auth.getSessionUser.mockResolvedValue({ user: { id: "officer-1" }, roles: ["officer"] })
  db.post.create.mockImplementation(async ({ data }: { data: object }) => ({ id: "post-1", ...data }))
  db.post.update.mockImplementation(async ({ data }: { data: object }) => ({ id: "post-1", ...data }))
  db.post.findUnique.mockResolvedValue({ id: "post-1", slug: "old-slug" })
})

describe("createPost", () => {
  it("returns { success, post } and refreshes the news pages", async () => {
    const result = await createPost(post())
    expect(result).toEqual({ success: true, post: expect.objectContaining({ id: "post-1", slug: "lsc-season-3" }) })
    expect(auth.requireRole).toHaveBeenCalledWith(["admin", "officer"])
    expect(audit.createAuditLog.mock.calls[0][0]).toMatchObject({ actorUserId: "officer-1", actionType: "CREATE" })
    expect(revalidated()).toEqual(["/admin/news", "/news"])
  })

  it("returns { success: false, error } for a taken slug, without refreshing", async () => {
    db.post.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" }))
    expect(await createPost(post())).toEqual({ success: false, error: "Slug already exists" })
    expect(next.revalidatePath).not.toHaveBeenCalled()
  })

  it("still throws for a post that doesn't validate, or no session", async () => {
    await expect(createPost(post({ title: "" }))).rejects.toThrow()
    auth.getSessionUser.mockResolvedValue({ user: null, roles: [] })
    await expect(createPost(post())).rejects.toThrow("Unauthorized")
    expect(db.post.create).not.toHaveBeenCalled()
  })
})

describe("updatePost", () => {
  it("returns { success, post } and refreshes the old and new addresses", async () => {
    const result = await updatePost("post-1", post())
    expect(result).toEqual({ success: true, post: expect.objectContaining({ id: "post-1" }) })
    expect(revalidated()).toEqual(["/admin/news", "/news", "/news/old-slug", "/news/lsc-season-3"])
  })

  it("returns { success: false, error } when the post is gone", async () => {
    db.post.findUnique.mockResolvedValue(null)
    expect(await updatePost("post-1", post())).toEqual({ success: false, error: "Post not found" })
  })

  it("still throws for a post that doesn't validate", async () => {
    await expect(updatePost("post-1", post({ slug: "Bad Slug" }))).rejects.toThrow()
    expect(db.post.update).not.toHaveBeenCalled()
  })
})
