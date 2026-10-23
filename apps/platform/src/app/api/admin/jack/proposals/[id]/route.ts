import { NextResponse, type NextRequest } from "next/server"
import { requireOfficer } from "@/server/auth/guards"
import { getProposalDetail } from "@/server/jack/proposals/service"

/**
 * One of Jack's proposals in full, for its card in the room (#188, design §4.1): the diff (long text as
 * a line diff), people, links, rows for list kinds, the live status and result, and whether the viewer
 * may apply it. Officers only. A pending proposal past its expiry is marked stale on the way.
 */

export const dynamic = "force-dynamic"

const ID = /^[0-9a-f-]{36}$/i

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let viewer
  try {
    viewer = await requireOfficer()
  } catch {
    return NextResponse.json({ error: "Officers only" }, { status: 403 })
  }

  const { id } = await params
  if (!ID.test(id)) return NextResponse.json({ error: "Bad request" }, { status: 400 })

  const detail = await getProposalDetail(id, viewer.id)
  if (!detail) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json(detail, { headers: { "cache-control": "no-store" } })
}
