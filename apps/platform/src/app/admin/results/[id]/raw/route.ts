import { NextResponse } from "next/server"
import { prisma } from "@/server/db"
import { requireOfficer } from "@/server/auth/guards"

/**
 * Downloads an upload's original results JSON. The results pages link here instead of shipping every
 * file's JSON to the browser just in case someone clicks download.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireOfficer()
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  const { id } = await params
  const upload = await prisma.rawResultUpload.findUnique({ where: { id }, select: { filename: true, rawJson: true } })
  if (!upload) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const asciiName = upload.filename.replace(/[^\w.-]+/g, "_") || "results.json"
  return new NextResponse(JSON.stringify(upload.rawJson, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(upload.filename)}`,
      "Cache-Control": "private, no-store",
    },
  })
}
