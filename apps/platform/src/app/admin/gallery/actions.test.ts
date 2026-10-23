import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ galleryImage: { findUnique: vi.fn(), deleteMany: vi.fn() } }))
const guards = vi.hoisted(() => ({ requireOfficer: vi.fn() }))
const audit = vi.hoisted(() => ({ createAuditLog: vi.fn() }))
const cloudinary = vi.hoisted(() => ({ destroyImage: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: db }))
vi.mock("@/server/auth/guards", () => guards)
vi.mock("@/server/audit/log", () => audit)
vi.mock("@/server/cloudinary", () => cloudinary)
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

import { deleteImage } from "./actions"

const JACK_COPY = "gallery/jack/file-33333333-3333-4333-8333-333333333333"

beforeEach(() => {
  vi.clearAllMocks()
  guards.requireOfficer.mockResolvedValue({ id: "u1" })
  cloudinary.destroyImage.mockResolvedValue(true)
  db.galleryImage.deleteMany.mockResolvedValue({ count: 1 })
})

describe("deleteImage", () => {
  it("takes a photo Jack added off Cloudinary first, then off the gallery, so the link /gallery showed stops working", async () => {
    db.galleryImage.findUnique.mockResolvedValue({ publicId: JACK_COPY })
    expect(await deleteImage("img-1")).toEqual({ ok: true })
    expect(db.galleryImage.findUnique).toHaveBeenCalledWith({ where: { id: "img-1" }, select: { publicId: true } })
    expect(cloudinary.destroyImage).toHaveBeenCalledWith(JACK_COPY)
    expect(db.galleryImage.deleteMany).toHaveBeenCalledWith({ where: { id: "img-1" } })
    expect(cloudinary.destroyImage.mock.invocationCallOrder[0]).toBeLessThan(db.galleryImage.deleteMany.mock.invocationCallOrder[0])
    expect(audit.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: "u1", actionType: "DELETE", entityType: "GALLERY_IMAGE", entityId: "img-1", metadata: { publicId: JACK_COPY, cloudinaryRemoved: true } }))
  })

  it("keeps the photo when Cloudinary won't delete its copy, and says so, so the officer can try again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    db.galleryImage.findUnique.mockResolvedValue({ publicId: JACK_COPY })
    cloudinary.destroyImage.mockResolvedValue(false)
    expect(await deleteImage("img-1")).toEqual({ ok: false, error: "Couldn't delete its copy on Cloudinary, so it's still on the gallery. Try again." })
    expect(db.galleryImage.deleteMany).not.toHaveBeenCalled()
    expect(audit.createAuditLog).not.toHaveBeenCalled()

    // Trying again works once Cloudinary answers (a copy already gone counts as deleted)
    cloudinary.destroyImage.mockResolvedValue(true)
    expect(await deleteImage("img-1")).toEqual({ ok: true })
    expect(db.galleryImage.deleteMany).toHaveBeenCalledTimes(1)
  })

  it("leaves an officer's own upload on Cloudinary, as before", async () => {
    db.galleryImage.findUnique.mockResolvedValue({ publicId: "lsr/gallery/abc123" })
    expect(await deleteImage("img-2")).toEqual({ ok: true })
    expect(cloudinary.destroyImage).not.toHaveBeenCalled()
    expect(audit.createAuditLog.mock.calls[0][0].metadata).toEqual({ publicId: "lsr/gallery/abc123" })
  })

  it("does nothing more for a photo that's already gone", async () => {
    db.galleryImage.findUnique.mockResolvedValue(null)
    expect(await deleteImage("img-3")).toEqual({ ok: true })
    db.galleryImage.findUnique.mockResolvedValue({ publicId: JACK_COPY })
    db.galleryImage.deleteMany.mockResolvedValue({ count: 0 })
    expect(await deleteImage("img-3")).toEqual({ ok: true })
    expect(audit.createAuditLog).not.toHaveBeenCalled()
  })

  it("is for officers only, and deletes nothing otherwise", async () => {
    guards.requireOfficer.mockRejectedValue(new Error("Forbidden"))
    await expect(deleteImage("img-1")).rejects.toThrow("Forbidden")
    expect(db.galleryImage.findUnique).not.toHaveBeenCalled()
    expect(db.galleryImage.deleteMany).not.toHaveBeenCalled()
    expect(cloudinary.destroyImage).not.toHaveBeenCalled()
  })
})
