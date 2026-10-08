import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { syncInstagram } from "@/server/services/instagram.service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Copies new Instagram posts and renews the access token when it's due.
 * Called hourly by GitHub Actions (see .github/workflows/instagram-cron.yml).
 * The response lands in public Actions logs, so it carries counts and errors only.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("Authorization");
  if (
    process.env.NODE_ENV === "production" &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await syncInstagram();
  if (result.added > 0 || result.removed > 0) revalidatePath("/news");

  // 200 even when the sync fails: an expired token would otherwise fail the workflow every
  // hour. The error shows on Admin → Instagram and as a warning in the workflow run.
  return NextResponse.json(result);
}
