import { createHash, timingSafeEqual } from "node:crypto";

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * Whether a cron request is allowed. Fails CLOSED: with no secret configured (or an empty one)
 * nobody is let in, so a missing environment variable can never turn the route public. The header
 * must be exactly `Bearer <secret>`, compared in constant time (both sides are hashed first so the
 * comparison is over equal-length buffers and leaks nothing about the secret's length).
 */
export function isAuthorizedCronRequest(authorizationHeader: string | null | undefined, secret: string | null | undefined): boolean {
  if (!secret || !authorizationHeader) return false;
  return timingSafeEqual(digest(authorizationHeader), digest(`Bearer ${secret}`));
}
