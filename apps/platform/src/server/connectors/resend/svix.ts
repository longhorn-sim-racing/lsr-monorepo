import { createHmac } from "node:crypto"

/**
 * A Svix signature ("v1,<base64>") the way Resend signs a webhook: HMAC-SHA256 over
 * "<svix-id>.<svix-timestamp>.<raw body>", keyed with the base64 part of the whsec_ secret. For the
 * fake's webhook sender, the smoke test and tests; the route itself verifies through the SDK.
 */
export function svixSignature(secret: string, id: string, timestampSeconds: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64")
  return `v1,${createHmac("sha256", key).update(`${id}.${timestampSeconds}.${body}`).digest("base64")}`
}
