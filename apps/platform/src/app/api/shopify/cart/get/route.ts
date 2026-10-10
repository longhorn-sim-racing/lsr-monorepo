import { getCart } from "@/lib/shopify/cart";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { cartId } = body;

    if (!cartId) {
      return NextResponse.json({ ok: false, error: "Missing cartId" }, { status: 400 });
    }

    const cart = await getCart(cartId);
    return NextResponse.json({ ok: true, cart }); // cart can be null if not found
  } catch (e) {
    console.error("Error getting cart:", e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}
