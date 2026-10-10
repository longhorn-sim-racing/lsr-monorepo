/** The public site. Use it where a page names the club's canonical address (metadata, JSON-LD). */
export const CANONICAL_SITE_URL = "https://www.longhornsimracing.org";

/**
 * This deployment's base URL, with no trailing slash, for links that must come back to the same
 * deployment: Stripe returns, email links, auth redirects, the RSS feed.
 * NEXT_PUBLIC_SITE_URL first, then the browser's origin (client); on the server, the canonical
 * address in production or the deployment's own URL on previews, then localhost.
 */
export function getSiteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (typeof window !== "undefined") return window.location.origin;
  if (process.env.VERCEL_ENV === "production") return CANONICAL_SITE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}
