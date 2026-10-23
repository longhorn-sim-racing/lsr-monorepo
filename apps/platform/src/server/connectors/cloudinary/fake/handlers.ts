import { createHash } from "node:crypto"
import type { FakeService } from "../../fakes/types"
import { imageInfo } from "./image-size"

/**
 * The Cloudinary fake, mounted at /cloudinary: the server's signed uploads (`src/server/cloudinary.ts`:
 * the feed sync's copies, deck slides for Instagram and the gallery), deletes, the Admin API ping, and
 * the uploaded images served back at a public-looking link, so the Instagram fake can fetch what was
 * uploaded the way Instagram fetches from res.cloudinary.com.
 * - POST /v1_1/:cloud/image/upload takes a multipart form (`file` as bytes, a URL or a data: URI) with
 *   `api_key`, `timestamp`, `signature`. With the fake's own key the signature is checked like
 *   Cloudinary's (SHA-1 of the sorted parameters plus the secret; 401 "Invalid Signature"), and a
 *   timestamp over an hour old is refused. Any other key is taken as it is: in fake mode the app sends
 *   whatever key is in env, and this fake must never need it. `overwrite=false` keeps an existing asset
 *   and answers `existing: true`.
 * - GET /res/:cloud/image/upload/v<version>/<public id>.<ext> serves the bytes (the `secure_url`).
 * - POST /v1_1/:cloud/image/destroy, GET /v1_1/:cloud/ping (Basic auth).
 * - Test hooks: POST /_fake/state { fail: N } makes the next N uploads answer 500; GET /_fake/state lists
 *   what's stored.
 */

export const CLOUDINARY_FAKE = {
  cloudName: "lsr-fake",
  apiKey: "fake-cloudinary-key",
  apiSecret: "fake-cloudinary-secret",
} as const

/** Parameters Cloudinary leaves out of the signature */
const UNSIGNED = new Set(["file", "api_key", "signature", "resource_type", "cloud_name"])

type Stored = { publicId: string; version: number; bytes: Uint8Array; format: string; width: number | null; height: number | null; createdAt: string }

const errorJson = (message: string, status: number) => Response.json({ error: { message } }, { status })

function sign(params: Record<string, string>, secret: string): string {
  const toSign = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&")
  return createHash("sha1").update(toSign + secret).digest("hex")
}

async function fileBytes(file: FormDataEntryValue): Promise<Uint8Array | null> {
  if (typeof file !== "string") return new Uint8Array(await file.arrayBuffer())
  const data = /^data:[^;,]+;base64,([A-Za-z0-9+/=\s]*)$/.exec(file)
  if (data) return new Uint8Array(Buffer.from(data[1], "base64"))
  if (/^https?:\/\//.test(file)) {
    const response = await fetch(file).catch(() => null)
    return response?.ok ? new Uint8Array(await response.arrayBuffer()) : null
  }
  return null
}

export const cloudinaryFake: FakeService = {
  id: "cloudinary",
  create() {
    const assets = new Map<string, Stored>()
    let failNext = 0
    let versions = 1_761_000_000

    const deliveryUrl = (baseUrl: string, cloud: string, asset: Stored) => `${baseUrl}/res/${cloud}/image/upload/v${asset.version}/${asset.publicId}.${asset.format}`
    const describe = (baseUrl: string, cloud: string, asset: Stored, existing: boolean) => ({
      asset_id: createHash("md5").update(asset.publicId).digest("hex"),
      public_id: asset.publicId,
      version: asset.version,
      width: asset.width,
      height: asset.height,
      format: asset.format,
      resource_type: "image",
      bytes: asset.bytes.length,
      created_at: asset.createdAt,
      url: deliveryUrl(baseUrl, cloud, asset).replace(/^https:/, "http:"),
      secure_url: deliveryUrl(baseUrl, cloud, asset),
      ...(existing ? { existing: true } : {}),
    })

    /** The signed fields of a form, or the error Cloudinary would answer */
    function checkSigned(form: FormData): Record<string, string> | Response {
      const params: Record<string, string> = {}
      for (const [key, value] of form.entries()) if (!UNSIGNED.has(key) && typeof value === "string") params[key] = value
      const apiKey = form.get("api_key")
      if (typeof apiKey !== "string" || !apiKey) return errorJson("Must supply api_key", 401)
      if (apiKey === CLOUDINARY_FAKE.apiKey) {
        if (form.get("signature") !== sign(params, CLOUDINARY_FAKE.apiSecret)) return errorJson("Invalid Signature", 401)
        const timestamp = Number(params.timestamp)
        if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 3_600) return errorJson("Stale request - reported time is more than 1 hour off", 400)
      }
      return params
    }

    return [
      {
        method: "POST",
        path: "/_fake/state",
        async handle(request) {
          const body = ((await request.json().catch(() => ({}))) ?? {}) as { fail?: unknown }
          if (typeof body.fail === "number") failNext = body.fail
          return Response.json({ failNext, assets: assets.size })
        },
      },
      {
        method: "GET",
        path: "/_fake/state",
        handle: () => Response.json({ failNext, assets: [...assets.values()].map((a) => ({ publicId: a.publicId, format: a.format, width: a.width, height: a.height, bytes: a.bytes.length })) }),
      },
      {
        method: "POST",
        path: "/v1_1/:cloud/image/upload",
        async handle(request, { params: route, baseUrl }) {
          const form = await request.formData().catch(() => null)
          if (!form) return errorJson("Upload preset or signature must be supplied", 400)
          const params = checkSigned(form)
          if (params instanceof Response) return params
          if (failNext > 0) {
            failNext--
            return errorJson("Server error (fake)", 500)
          }
          const file = form.get("file")
          if (!file) return errorJson("Missing required parameter - file", 400)
          const publicId = params.public_id || createHash("sha1").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 20)
          const existing = assets.get(publicId)
          if (existing && params.overwrite === "false") return Response.json(describe(baseUrl, route.cloud, existing, true))
          const bytes = await fileBytes(file)
          if (!bytes) return errorJson("Resource not found - the file couldn't be read", 400)
          const info = imageInfo(bytes)
          if (!info) return errorJson("Invalid image file", 400)
          const asset: Stored = { publicId, version: ++versions, bytes, format: info.format, width: info.width, height: info.height, createdAt: new Date().toISOString() }
          assets.set(publicId, asset)
          return Response.json(describe(baseUrl, route.cloud, asset, false))
        },
      },
      {
        method: "POST",
        path: "/v1_1/:cloud/image/destroy",
        async handle(request) {
          const form = await request.formData().catch(() => null)
          if (!form) return errorJson("Missing required parameter - public_id", 400)
          const params = checkSigned(form)
          if (params instanceof Response) return params
          return Response.json({ result: assets.delete(params.public_id ?? "") ? "ok" : "not found" })
        },
      },
      {
        method: "GET",
        path: "/v1_1/:cloud/ping",
        handle(request) {
          const auth = /^Basic\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
          const [key, secret] = auth ? Buffer.from(auth, "base64").toString().split(":") : []
          if (!key || !secret) return errorJson("Must supply api_key", 401)
          if (key === CLOUDINARY_FAKE.apiKey && secret !== CLOUDINARY_FAKE.apiSecret) return errorJson("Invalid api_secret", 401)
          return Response.json({ status: "ok" })
        },
      },
      {
        method: "GET",
        path: "/res/:cloud/image/upload/*",
        handle(_request, { params }) {
          // v<version>/<public id>.<ext>
          const match = /^(?:v\d+\/)?(.+)\.[a-z0-9]+$/i.exec(params["*"] ?? "")
          const asset = match ? assets.get(match[1]) : undefined
          if (!asset) return new Response("Not found", { status: 404 })
          return new Response(new Uint8Array(asset.bytes), { headers: { "content-type": asset.format === "png" ? "image/png" : "image/jpeg", "content-length": String(asset.bytes.length) } })
        },
      },
    ]
  },
}
