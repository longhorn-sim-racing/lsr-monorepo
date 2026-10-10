const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function formatCents(cents: number): string {
  return usd.format(cents / 100);
}

/** Like formatCents, but whole dollars drop the ".00": 1000 → "$10", 1050 → "$10.50". */
export function formatCentsShort(cents: number): string {
  return cents % 100 ? usd.format(cents / 100) : usdWhole.format(cents / 100);
}

/** Cents as a plain dollar string for form inputs, e.g. 1050 → "10.50". */
export function centsToDollarInput(cents: number | null | undefined): string {
  return cents == null ? "" : (cents / 100).toFixed(2);
}

/**
 * Parses "10", "10.5", "$10.50" into integer cents without float rounding.
 * Returns null for anything that isn't a plain dollar amount.
 */
export function dollarsToCents(input: string): number | null {
  const match = /^\$?(\d*)(?:\.(\d{0,2}))?$/.exec(input.trim());
  if (!match || (!match[1] && !match[2])) return null;
  return Number(match[1] || "0") * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}
