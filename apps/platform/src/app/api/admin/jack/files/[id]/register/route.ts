import { NextResponse } from "next/server"
import type { JackRegisterResult } from "@/lib/jack/files"
import { requireOfficer } from "@/server/auth/guards"
import { registerFile } from "@/server/jack/files/register"
import type { FileProblem } from "@/server/jack/files/service"

/**
 * Finishes an upload (#188, design §5): after the browser uploaded the bytes, this checks them (size,
 * magic bytes, sha256), makes the photo copies and extracts text, then marks the file READY or FAILED.
 * Only the officer who attached it can. A route, not a server action: actions run one at a time per
 * tab, and reading a big PDF would hold up everything else the room does.
 */

export const dynamic = "force-dynamic"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STATUS: Record<FileProblem, number> = { bad_request: 422, not_found: 404, forbidden: 403, unavailable: 503 }

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let officerId: string
  try {
    officerId = (await requireOfficer()).id
  } catch {
    return answer({ ok: false, error: "Officers only" }, 403)
  }

  const { id } = await params
  if (!UUID.test(id)) return answer({ ok: false, error: "That file doesn't exist." }, 404)

  const result = await registerFile(id, officerId)
  return result.ok ? answer({ ok: true, file: result.data }, 200) : answer({ ok: false, error: result.error }, STATUS[result.code])
}

function answer(body: JackRegisterResult, status: number) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } })
}
