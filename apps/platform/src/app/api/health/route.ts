import { NextResponse } from "next/server";
import { prisma } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHECK_TIMEOUT_MS = 5_000;
const headers = { "Cache-Control": "no-store" };

/** Public readiness check: no user data, credentials, or database errors in the response. */
export async function GET() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Reuse the app's connection pool. The deadline bounds the HTTP response; it does
    // not cancel Prisma's query, which remains subject to the database/pool timeouts.
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Health check timed out")), CHECK_TIMEOUT_MS);
      }),
    ]);
    return NextResponse.json({ status: "ok" }, { status: 200, headers });
  } catch {
    return NextResponse.json({ status: "unavailable" }, { status: 503, headers });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
