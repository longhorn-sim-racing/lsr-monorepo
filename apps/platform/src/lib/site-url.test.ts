import { beforeEach, describe, expect, it, vi } from "vitest"
import { CANONICAL_SITE_URL, getSiteUrl } from "./site-url"

describe("getSiteUrl (server)", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "")
    vi.stubEnv("VERCEL_ENV", "")
    vi.stubEnv("VERCEL_URL", "")
  })

  it("uses NEXT_PUBLIC_SITE_URL without a trailing slash", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.longhornsimracing.org/")
    expect(getSiteUrl()).toBe("https://www.longhornsimracing.org")
  })

  it("treats an empty NEXT_PUBLIC_SITE_URL as unset", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "  ")
    vi.stubEnv("VERCEL_URL", "lsr-abc123.vercel.app")
    expect(getSiteUrl()).toBe("https://lsr-abc123.vercel.app")
  })

  it("falls back to the canonical domain in production, never a deployment URL", () => {
    vi.stubEnv("VERCEL_ENV", "production")
    vi.stubEnv("VERCEL_URL", "lsr-abc123.vercel.app")
    expect(getSiteUrl()).toBe(CANONICAL_SITE_URL)
  })

  it("uses the deployment's own URL on previews", () => {
    vi.stubEnv("VERCEL_ENV", "preview")
    vi.stubEnv("VERCEL_URL", "lsr-git-branch.vercel.app")
    expect(getSiteUrl()).toBe("https://lsr-git-branch.vercel.app")
  })

  it("falls back to localhost", () => {
    expect(getSiteUrl()).toBe("http://localhost:3000")
  })
})
