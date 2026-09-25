import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/server/auth/session";
import { createProductCheckoutSession } from "@/server/services/payment.service";

const bodySchema = z.discriminatedUnion("product", [
  z.object({ product: z.literal("ANNUAL_DUES") }),
  z.object({ product: z.literal("LEAGUE_FEE"), league: z.string().min(1) }),
]);

/**
 * POST /api/checkout
 * body: { product: "ANNUAL_DUES" } | { product: "LEAGUE_FEE", league: "<league slug>" }
 * 200 { url } · 400 { message } · 401 when signed out
 */
export async function POST(req: NextRequest) {
  const { user } = await getSessionUser();
  if (!user) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ message: "Invalid checkout request." }, { status: 400 });
  }

  const { product } = parsed.data;
  const league = product === "LEAGUE_FEE" ? parsed.data.league : undefined;

  try {
    const url = await createProductCheckoutSession(user.id, product, league);
    return NextResponse.json({ url });
  } catch (error) {
    return NextResponse.json(
      {
        message:
          error instanceof Error ? error.message : "Failed to create checkout session",
      },
      { status: 400 }
    );
  }
}
