import { describe, expect, it, vi } from "vitest"
import { registerUpload, uploadError, uploadToSignedUrl, type UploadXhr } from "./upload"

/** A stand-in XMLHttpRequest that records the request and lets the test finish it */
function fakeXhr() {
  const sent: { method?: string; url?: string; headers: Record<string, string>; body?: FormData } = { headers: {} }
  const xhr: UploadXhr = {
    upload: { onprogress: null },
    onload: null,
    onerror: null,
    ontimeout: null,
    onabort: null,
    status: 0,
    responseText: "",
    timeout: 0,
    open: vi.fn((method: string, url: string) => Object.assign(sent, { method, url })) as unknown as UploadXhr["open"],
    setRequestHeader: vi.fn((name: string, value: string) => void (sent.headers[name] = value)),
    send: vi.fn((body: FormData) => void (sent.body = body)) as unknown as UploadXhr["send"],
    abort: vi.fn(() => xhr.onabort?.()),
  }
  const finish = (status: number, responseText = "") => {
    Object.assign(xhr, { status, responseText })
    xhr.onload?.()
  }
  return { xhr, sent, finish }
}

describe("uploadToSignedUrl", () => {
  it("sends what supabase-js's uploadToSignedUrl sends, typed as the server said, with progress", async () => {
    const { xhr, sent, finish } = fakeXhr()
    const progress: number[] = []
    const file = new File(["hello world"], "notes.md", { type: "" })
    const done = uploadToSignedUrl("https://x.supabase.co/storage/v1/object/upload/sign/jack/rooms/r/f/notes.md?token=t", file, "text/markdown", {
      apikey: "anon-key",
      onProgress: (p) => progress.push(p),
      makeXhr: () => xhr,
    })
    expect(sent.method).toBe("PUT")
    expect(sent.headers).toEqual({ "x-upsert": "false", apikey: "anon-key" })
    expect(sent.body?.get("cacheControl")).toBe("3600")
    const part = sent.body?.get("") as Blob
    expect(part.type).toBe("text/markdown")
    expect(await part.text()).toBe("hello world")
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 })
    xhr.upload.onprogress?.({ lengthComputable: false, loaded: 0, total: 0 })
    finish(200, '{"Key":"jack/rooms/r/f/notes.md"}')
    expect(await done).toEqual({ ok: true })
    expect(progress).toEqual([0.5])
  })

  it("sends no apikey to the local upload route", async () => {
    const { xhr, sent, finish } = fakeXhr()
    const done = uploadToSignedUrl("/api/admin/jack/files/f/upload", new Blob(["x"]), "text/plain", { makeXhr: () => xhr })
    finish(200)
    await done
    expect(sent.headers).toEqual({ "x-upsert": "false" })
  })

  it("explains Storage's errors", async () => {
    const { xhr, finish } = fakeXhr()
    const done = uploadToSignedUrl("https://x/upload", new Blob(["x"]), "image/png", { makeXhr: () => xhr })
    finish(400, JSON.stringify({ statusCode: "413", error: "Payload too large", message: "The object exceeded the maximum allowed size" }))
    expect(await done).toEqual({ ok: false, error: "This file is over the storage size limit." })
  })

  it("reports a dropped connection, and an abort as removed", async () => {
    const failing = fakeXhr()
    const failed = uploadToSignedUrl("https://x/upload", new Blob(["x"]), "image/png", { makeXhr: () => failing.xhr })
    failing.xhr.onerror?.()
    expect(await failed).toMatchObject({ ok: false, error: expect.stringContaining("Check your connection") })

    const stopping = fakeXhr()
    const abort = new AbortController()
    const stopped = uploadToSignedUrl("https://x/upload", new Blob(["x"]), "image/png", { makeXhr: () => stopping.xhr, signal: abort.signal })
    abort.abort()
    expect(await stopped).toEqual({ ok: false, error: "Removed", aborted: true })
    expect(stopping.xhr.abort).toHaveBeenCalled()
  })
})

describe("uploadError", () => {
  it("maps each Storage error to what to do", () => {
    expect(uploadError(400, '{"statusCode":"415","error":"invalid_mime_type","message":"mime type text/html is not supported"}')).toBe("Storage doesn't take this type of file.")
    expect(uploadError(400, '{"statusCode":"409","error":"Duplicate","message":"The resource already exists"}')).toContain("already uploaded")
    expect(uploadError(400, '{"statusCode":"400","error":"InvalidSignature","message":"Invalid signature"}')).toContain("link expired")
    expect(uploadError(403, "")).toContain("refused")
    expect(uploadError(502, "<html>Bad gateway</html>")).toBe("The upload failed (502). Remove the file and try again.")
  })
})

describe("registerUpload", () => {
  it("posts to the register route and returns its answer", async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true, file: { id: "f" } })) as unknown as typeof fetch
    expect(await registerUpload("f", fetcher)).toEqual({ ok: true, file: { id: "f" } })
    expect(fetcher).toHaveBeenCalledWith("/api/admin/jack/files/f/register", { method: "POST" })
  })

  it("turns a broken answer or no connection into a message", async () => {
    expect(await registerUpload("f", (async () => new Response("<html>", { status: 504 })) as unknown as typeof fetch)).toMatchObject({ ok: false, error: expect.stringContaining("(504)") })
    expect(
      await registerUpload("f", (async () => {
        throw new TypeError("Failed to fetch")
      }) as unknown as typeof fetch)
    ).toMatchObject({ ok: false, error: expect.stringContaining("Couldn't reach the server") })
  })
})
