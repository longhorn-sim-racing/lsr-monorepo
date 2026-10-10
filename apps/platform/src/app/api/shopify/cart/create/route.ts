import { createCart } from "@/lib/shopify/cart";
import { NextResponse } from "next/server";

export async function POST() {
  try {
    const cart = await createCart();
    return NextResponse.json({ ok: true, cart });
  } catch (e) {
    console.error("Error creating cart:", e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}
