import { NextRequest, NextResponse } from "next/server";
import { handleStripeWebhook } from "@/server/services/payment.service";

export async function POST(req: NextRequest) {
  const rawBody = Buffer.from(await req.arrayBuffer());
  const signature = req.headers.get("stripe-signature") ?? "";

  try {
    await handleStripeWebhook(rawBody, signature);
    return NextResponse.json({ received: true });
  } catch (error) {
    // The stack only: Stripe's signature error carries the raw request body (and its header), so logging
    // the error object would put whatever anyone posted here into the function log
    console.error("[Stripe Webhook] Error:", error instanceof Error ? (error.stack ?? error.message) : "Unknown error");
    return NextResponse.json(
      {
        message:
          error instanceof Error ? error.message : "Webhook processing error",
      },
      { status: 400 }
    );
  }
}
