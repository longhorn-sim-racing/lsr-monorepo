import { inspect } from "node:util";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const payments = vi.hoisted(() => ({ handleStripeWebhook: vi.fn() }));
vi.mock("@/server/services/payment.service", () => payments);

import { POST } from "./route";

const FORGED = '{"type":"checkout.session.completed","note":"forged-body-marker"}';

function post(body = FORGED) {
  return POST(new NextRequest("http://localhost/api/stripe/webhook", { method: "POST", body, headers: { "stripe-signature": "t=1,v1=bad" } }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/stripe/webhook", () => {
  it("answers 200 once the event is handled", async () => {
    payments.handleStripeWebhook.mockResolvedValue(undefined);
    const response = await post();
    expect(response.status).toBe(200);
    expect(payments.handleStripeWebhook).toHaveBeenCalledWith(Buffer.from(FORGED), "t=1,v1=bad");
  });

  it("logs a bad signature without the request body Stripe's error carries", async () => {
    // Stripe's StripeSignatureVerificationError keeps the payload and header on the error object
    const error = Object.assign(new Error("No signatures found matching the expected signature for payload."), { payload: FORGED, header: "t=1,v1=bad" });
    payments.handleStripeWebhook.mockRejectedValue(error);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await post();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: error.message });
    expect(log).toHaveBeenCalledTimes(1);
    // As console.error prints them: an object's own properties show
    const logged = log.mock.calls[0].map((arg) => inspect(arg)).join(" ");
    expect(logged).toContain("No signatures found");
    expect(logged).not.toContain("forged-body-marker");
  });
});
