import { NextRequest, NextResponse } from "next/server";
import { requireOfficer } from "@/server/auth/guards";
import { getSiteUrl } from "@/lib/site-url";
import { isTrackKey } from "@/schemas/recruiting.schema";
import { parseTrackStatus } from "@/lib/recruiting/labels";
import { exportRound } from "@/server/services/recruiting-export.service";

export const dynamic = "force-dynamic";

/**
 * GET /admin/recruiting/export?cycle=<slug>[&team=&status=&q=&auto=1]
 * One CSV row per submitted team application in the round, filtered like the list. Officers only.
 * The file holds applicants' personal details, so the download is audit-logged and never cached.
 */
export async function GET(req: NextRequest) {
  let officerId: string;
  try {
    officerId = (await requireOfficer()).id;
  } catch {
    return NextResponse.json({ message: "Forbidden" }, { status: 403 });
  }

  const params = req.nextUrl.searchParams;
  const slug = params.get("cycle");
  if (!slug) return NextResponse.json({ message: "Missing round" }, { status: 400 });

  // Anything in the URL is untrusted: only known teams and statuses become filters
  const team = params.get("team");
  const result = await exportRound(
    officerId,
    slug,
    {
      track: team && isTrackKey(team) ? team : undefined,
      status: parseTrackStatus(params.get("status")),
      autoSubmitted: params.get("auto") === "1" ? true : undefined,
      q: params.get("q")?.trim().slice(0, 100) || undefined,
    },
    { adminBaseUrl: getSiteUrl() },
  );
  if (!result) return NextResponse.json({ message: "Unknown round" }, { status: 404 });

  return new NextResponse(result.csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
