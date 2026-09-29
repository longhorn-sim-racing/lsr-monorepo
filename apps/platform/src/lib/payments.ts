import type { PaymentStatus, ProductType } from "@prisma/client";

export const PAYMENT_STATUSES = ["succeeded", "pending", "failed", "refunded"] as const satisfies readonly PaymentStatus[];

export const PAYMENT_KIND_LABELS = {
  dues: "Dues",
  league: "League entry",
  event: "Event fee",
} as const;

export type PaymentKind = keyof typeof PAYMENT_KIND_LABELS;

export const PRODUCT_TYPE_LABELS: Record<ProductType, string> = {
  ANNUAL_DUES: "Annual dues",
  LEAGUE_FEE: "League fee",
  EVENT_FEE: "Event fee",
};

export function isPaymentStatus(value: string | undefined): value is PaymentStatus {
  return PAYMENT_STATUSES.includes(value as PaymentStatus);
}

export function isPaymentKind(value: string | undefined): value is PaymentKind {
  return value !== undefined && Object.hasOwn(PAYMENT_KIND_LABELS, value);
}

/** Productless payments come from event checkout, which links the registration once paid. */
export function paymentKind(payment: {
  productId: string | null;
  product: { type: ProductType } | null;
  eventRegistration: unknown;
}): PaymentKind | null {
  if (payment.product?.type === "ANNUAL_DUES") return "dues";
  if (payment.product?.type === "LEAGUE_FEE") return "league";
  if (payment.eventRegistration || payment.product?.type === "EVENT_FEE" || !payment.productId) return "event";
  return null;
}

export function stripeDashboardUrl(providerRef: string | null): string | null {
  if (providerRef?.startsWith("pi_")) return `https://dashboard.stripe.com/payments/${providerRef}`;
  if (providerRef?.startsWith("cs_")) return `https://dashboard.stripe.com/checkout/sessions/${providerRef}`;
  return null;
}
