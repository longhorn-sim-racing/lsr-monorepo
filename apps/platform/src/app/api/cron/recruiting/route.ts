import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/recruiting/cron-auth";
import { sweepAndNotify } from "@/server/services/recruiting-email.service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The recruiting deadline job: after a round closes, submits every complete draft for its applicant
 * and leaves incomplete ones alone. Called every 15 minutes by GitHub Actions
 * (.github/workflows/recruiting-cron.yml) and safe to call any number of times.
 *
 * Unlike the other cron routes this one fails CLOSED: with no CRON_SECRET set, every request is
 * refused (in every environment, not just production).
 */
export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request.headers.get("Authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await sweepAndNotify();
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    console.error("[Cron] Recruiting sweep failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false, error: "Sweep failed" }, { status: 500 });
  }
}
