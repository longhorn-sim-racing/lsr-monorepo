import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { revalidatePath } from "next/cache";
import { syncInstagram } from "@/server/services/instagram.service";

export const dynamic = "force-dynamic";

/**
 * Copies new Instagram posts and renews the access token when it's due.
 * Called hourly by GitHub Actions (see .github/workflows/instagram-cron.yml).
 * The response lands in public Actions logs, so it carries counts only.
 */
export async function GET(request: Request) {
  // Fails closed: with no CRON_SECRET set, every request is refused (in every environment)
  if (!isAuthorizedCronRequest(request.headers.get("Authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await syncInstagram();
  if (result.added > 0 || result.removed > 0) revalidatePath("/news");

  // 200 even when the sync fails: an expired token would otherwise fail the workflow every
  // hour. The details show on Admin → Instagram; the public log only learns that something's up.
  return NextResponse.json({
    ok: result.ok,
    skipped: result.skipped ?? null,
    added: result.added,
    updated: result.updated,
    removed: result.removed,
    problem: Boolean(result.error),
  });
}
