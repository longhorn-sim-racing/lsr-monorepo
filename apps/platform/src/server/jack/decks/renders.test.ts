import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }))
vi.mock("@/server/db", () => ({ prisma: { jackFile: { findFirst } } }))

vi.mock("./renderer", () => ({
  renderSlide: vi.fn(async () => ({
    png: Buffer.from("png"),
    jpg: Buffer.from("jpg"),
    view: Buffer.from("view"),
    thumb: Buffer.from("thumb"),
    issues: ["Text \"x\" overlaps \"y\"."],
    transient: false,
    ms: 12,
  })),
}))

import { renderKey } from "./document"
import { renderSlide } from "./renderer"
import { ensureRender, getRenderFile, resolveJackAsset } from "./renders"
import { memoryStore } from "./memory-store"
import { fileStore, setJackFileStore } from "./storage"

const source = { size: "slides" as const, css: "", html: '<section class="slide dark">Hi</section>' }
let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "jack-renders-"))
  setJackFileStore(fileStore(root))
  vi.mocked(renderSlide).mockClear()
})

afterEach(() => {
  setJackFileStore(null)
  rmSync(root, { recursive: true, force: true })
})

describe("ensureRender", () => {
  it("renders once, stores the files, and reuses them after that", async () => {
    const first = await ensureRender(source, { withView: true })
    expect(first).toMatchObject({ key: renderKey(source), issues: ['Text "x" overlaps "y".'], cached: false })
    expect(first.view?.toString()).toBe("view")

    const again = await ensureRender(source, { withView: true })
    expect(again).toMatchObject({ cached: true, issues: ['Text "x" overlaps "y".'] })
    expect(again.view?.toString()).toBe("view")
    expect(renderSlide).toHaveBeenCalledTimes(1)
  })

  it("never gives a deck another room's render, however a room photo's URL is written", async () => {
    // The renderer loads https://JACK.ASSETS/ROOM/<id> as the deck's room photo, like the lowercase form
    const photo = { ...source, html: '<section><img src="https://JACK.ASSETS/ROOM/11111111-2222-4333-8444-555555555555"></section>' }
    await Promise.all([ensureRender({ ...photo, roomId: "room-1" }), getRenderFile({ ...photo, roomId: "room-2" }, "png")])
    await ensureRender({ ...photo, roomId: "room-2" })
    expect(vi.mocked(renderSlide).mock.calls.map(([made]) => made.roomId)).toEqual(["room-1", "room-2"])
  })

  it("shares one render between two callers asking at once", async () => {
    const other = { ...source, html: "<section>Other</section>" }
    await Promise.all([ensureRender(other), ensureRender(other), getRenderFile(other, "thumb")])
    expect(renderSlide).toHaveBeenCalledTimes(1)
  })
})

describe("renders that may come out better next time", () => {
  it("aren't cached, so the next request renders again, and say so", async () => {
    const slow = { ...source, html: "<section>Slow photo</section>" }
    const base = await vi.mocked(renderSlide).getMockImplementation()!(slow)
    vi.mocked(renderSlide).mockResolvedValueOnce({ ...base, transient: true, issues: ["Some images were still loading after 20 s"] })
    const first = await getRenderFile(slow, "png")
    expect(first.transient).toBe(true)
    const second = await getRenderFile(slow, "png")
    expect(second.transient).toBe(false)
    expect(renderSlide).toHaveBeenCalledTimes(2)
  })

  it("still come back when the store can't be written to", async () => {
    setJackFileStore({ ...memoryStore("blob"), put: async () => { throw new Error("Blob auth failed") } })
    vi.spyOn(console, "error").mockImplementation(() => {})
    const result = await ensureRender({ ...source, html: "<section>Store down</section>" }, { withView: true })
    expect(result.view?.toString()).toBe("view")
  })
})

describe("getRenderFile", () => {
  it("serves a stored file, rendering the slide first when it's missing", async () => {
    const thumb = await getRenderFile(source, "thumb")
    expect(thumb.body.toString()).toBe("thumb")
    const png = await getRenderFile(source, "png")
    expect(png.body.toString()).toBe("png")
    expect(renderSlide).toHaveBeenCalledTimes(1)
  })
})

describe("resolveJackAsset", () => {
  it("makes QR codes", async () => {
    const qr = await resolveJackAsset(new URL("https://jack.assets/qr?text=https%3A%2F%2Fwww.longhornsimracing.org%2Fapply"))
    expect(qr?.contentType).toBe("image/png")
    expect(qr?.body.subarray(1, 4).toString()).toBe("PNG")
  })

  it("serves stored private images by safe names only", async () => {
    await fileStore(root).put("jack/assets/shot-1.png", Buffer.from("shot"), "image/png")
    expect((await resolveJackAsset(new URL("https://jack.assets/files/shot-1.png")))?.body.toString()).toBe("shot")
    expect(await resolveJackAsset(new URL("https://jack.assets/files/../../secret.png"))).toBeNull()
    expect(await resolveJackAsset(new URL("https://jack.assets/files/missing.png"))).toBeNull()
  })

  it("refuses empty or oversized QR text and unknown paths", async () => {
    expect(await resolveJackAsset(new URL("https://jack.assets/qr"))).toBeNull()
    expect(await resolveJackAsset(new URL(`https://jack.assets/qr?text=${"a".repeat(700)}`))).toBeNull()
    expect(await resolveJackAsset(new URL("https://jack.assets/other"))).toBeNull()
  })

  describe("room photos", () => {
    const FILE = "11111111-2222-4333-8444-555555555555"
    const url = new URL(`https://jack.assets/room/${FILE}`)

    it("serves a photo posted in the deck's room as its model copy, checking the room", async () => {
      await fileStore(root).put(`rooms/room-1/${FILE}/derived/model.jpg`, Buffer.from("jpeg"), "image/jpeg")
      findFirst.mockResolvedValueOnce({ modelCopyPath: `rooms/room-1/${FILE}/derived/model.jpg` })
      expect(await resolveJackAsset(url, { roomId: "room-1" })).toEqual({ body: Buffer.from("jpeg"), contentType: "image/jpeg" })
      expect(findFirst).toHaveBeenCalledWith({
        where: { id: FILE, roomId: "room-1", kind: "IMAGE", status: "READY", messageId: { not: null } },
        select: { modelCopyPath: true },
      })
    })

    it("finds nothing for another room's photo, with no room, or for anything that isn't a file id", async () => {
      findFirst.mockResolvedValueOnce(null)
      expect(await resolveJackAsset(url, { roomId: "room-2" })).toBeNull()
      expect(await resolveJackAsset(url)).toBeNull()
      expect(await resolveJackAsset(new URL("https://jack.assets/room/../files/x.png"), { roomId: "room-1" })).toBeNull()
      expect(await resolveJackAsset(new URL("https://jack.assets/room/not-an-id"), { roomId: "room-1" })).toBeNull()
      expect(findFirst).toHaveBeenCalledTimes(1)
    })

    it("are answered for the room the slide is rendered for", async () => {
      await ensureRender({ ...source, html: `<section><img src="${url}"></section>`, roomId: "room-7" })
      const { assets } = vi.mocked(renderSlide).mock.calls.at(-1)![1]!
      findFirst.mockResolvedValueOnce(null)
      await assets!(url)
      expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ roomId: "room-7" }) }))
    })
  })
})

describe("fileStore", () => {
  it("keeps paths inside its folder", async () => {
    await expect(fileStore(root).put("../escape.png", Buffer.from("x"), "image/png")).rejects.toThrow("Bad store path")
    expect(await fileStore(root).get("nothing/here.png")).toBeNull()
  })
})
