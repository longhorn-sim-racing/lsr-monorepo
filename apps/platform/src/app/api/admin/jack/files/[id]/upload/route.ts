import { NextResponse } from "next/server"
import { MAX_FILE_BYTES } from "@/lib/jack/files"
import { requireOfficer } from "@/server/auth/guards"
import { storeLocalUpload } from "@/server/jack/files/service"

/**
 * Development only: where the browser uploads a room file when Jack's files are kept on disk (the
 * `files` store, `.jack-renders/`), standing in for Supabase's signed upload URL. It takes the same
 * request uploadToSignedUrl sends (a PUT with the file in a form), for an UPLOADING file of the
 * signed-in officer's, once. With any other store it answers 404.
 */

export const dynamic = "force-dynamic"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** The form's boundaries and its small cacheControl field */
const FORM_OVERHEAD = 64 * 1024
const STATUS = { bad_request: 400, not_found: 404, forbidden: 403, unavailable: 503 }

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let officerId: string
  try {
    officerId = (await requireOfficer()).id
  } catch {
    return NextResponse.json({ error: "Officers only" }, { status: 403 })
  }
  const { id } = await params
  if (!UUID.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (Number(req.headers.get("content-length") ?? 0) > MAX_FILE_BYTES + FORM_OVERHEAD) return NextResponse.json({ error: "Too large" }, { status: 413 })

  let body: Buffer
  try {
    if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
      const form = await req.formData()
      const file = [...form.values()].find((value): value is File => typeof value !== "string")
      if (!file) return NextResponse.json({ error: "No file in the upload" }, { status: 400 })
      body = Buffer.from(await file.arrayBuffer())
    } else {
      body = Buffer.from(await req.arrayBuffer())
    }
  } catch {
    return NextResponse.json({ error: "Couldn't read the upload" }, { status: 400 })
  }

  const result = await storeLocalUpload(id, officerId, body)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: STATUS[result.code] })
  return NextResponse.json({ Key: id })
}
