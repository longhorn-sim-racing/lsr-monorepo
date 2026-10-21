import { describe, expect, it } from "vitest";
import { launchBlocked } from "./launch";

describe("launchBlocked", () => {
  it("blocks the real site while the questions are placeholders", () => {
    expect(launchBlocked(true, { VERCEL_ENV: "production" })).toBe(true);
  });

  it("lets local development and previews through, so the form can be built and tested", () => {
    expect(launchBlocked(true, {})).toBe(false);
    expect(launchBlocked(true, { VERCEL_ENV: "preview" })).toBe(false);
    expect(launchBlocked(true, { VERCEL_ENV: "development" })).toBe(false);
  });

  it("lets everything through once the real content is in", () => {
    expect(launchBlocked(false, { VERCEL_ENV: "production" })).toBe(false);
    expect(launchBlocked(false, {})).toBe(false);
  });

  it("reads the real placeholder flag by default (false now the real content is in)", () => {
    expect(launchBlocked(undefined, { VERCEL_ENV: "production" })).toBe(false);
  });
});
