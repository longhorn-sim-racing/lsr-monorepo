import { addLines } from "@/lib/shopify/cart";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { cartId, merchandiseId, quantity } = body;

    if (!cartId || !merchandiseId || !quantity) {
      return NextResponse.json({ ok: false, error: "Missing parameters" }, { status: 400 });
    }

    const cart = await addLines(cartId, [{ merchandiseId, quantity }]);
    return NextResponse.json({ ok: true, cart });
  } catch (e) {
    console.error("Error adding to cart:", e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}
