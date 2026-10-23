import { beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({ galleryImage: { delete: vi.fn() } }))
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
})

describe("deleteImage", () => {
  it("takes a photo Jack added off Cloudinary too, so the link /gallery showed stops working", async () => {
    db.galleryImage.delete.mockResolvedValue({ publicId: JACK_COPY })
    expect(await deleteImage("img-1")).toEqual({ keptCopy: null })
    expect(db.galleryImage.delete).toHaveBeenCalledWith({ where: { id: "img-1" }, select: { publicId: true } })
    expect(cloudinary.destroyImage).toHaveBeenCalledWith(JACK_COPY)
    expect(audit.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: "u1", actionType: "DELETE", entityType: "GALLERY_IMAGE", entityId: "img-1", metadata: { publicId: JACK_COPY, cloudinaryRemoved: true } }))
  })

  it("says which copy is still live when Cloudinary won't delete it, and records that", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    db.galleryImage.delete.mockResolvedValue({ publicId: JACK_COPY })
    cloudinary.destroyImage.mockResolvedValue(false)
    expect(await deleteImage("img-1")).toEqual({ keptCopy: JACK_COPY })
    expect(audit.createAuditLog.mock.calls[0][0].metadata).toEqual({ publicId: JACK_COPY, cloudinaryRemoved: false })
  })

  it("leaves an officer's own upload on Cloudinary, as before", async () => {
    db.galleryImage.delete.mockResolvedValue({ publicId: "lsr/gallery/abc123" })
    expect(await deleteImage("img-2")).toEqual({ keptCopy: null })
    expect(cloudinary.destroyImage).not.toHaveBeenCalled()
    expect(audit.createAuditLog.mock.calls[0][0].metadata).toEqual({ publicId: "lsr/gallery/abc123" })
  })

  it("is for officers only, and deletes nothing otherwise", async () => {
    guards.requireOfficer.mockRejectedValue(new Error("Forbidden"))
    await expect(deleteImage("img-1")).rejects.toThrow("Forbidden")
    expect(db.galleryImage.delete).not.toHaveBeenCalled()
    expect(cloudinary.destroyImage).not.toHaveBeenCalled()
  })
})
