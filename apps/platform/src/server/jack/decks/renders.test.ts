import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
})

describe("fileStore", () => {
  it("keeps paths inside its folder", async () => {
    await expect(fileStore(root).put("../escape.png", Buffer.from("x"), "image/png")).rejects.toThrow("Bad store path")
    expect(await fileStore(root).get("nothing/here.png")).toBeNull()
  })
})
