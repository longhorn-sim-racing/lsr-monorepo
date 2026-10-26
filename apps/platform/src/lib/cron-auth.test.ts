import { describe, expect, it } from "vitest";
import { isAuthorizedCronRequest } from "./cron-auth";

describe("isAuthorizedCronRequest", () => {
  it("accepts the exact bearer secret", () => {
    expect(isAuthorizedCronRequest("Bearer s3cret", "s3cret")).toBe(true);
  });

  it("fails closed when no secret is configured, even if the request sends something", () => {
    expect(isAuthorizedCronRequest("Bearer undefined", undefined)).toBe(false);
    expect(isAuthorizedCronRequest("Bearer ", "")).toBe(false);
    expect(isAuthorizedCronRequest("Bearer ", null)).toBe(false);
    expect(isAuthorizedCronRequest("", "")).toBe(false);
  });

  it("rejects a missing, wrong, or differently shaped header", () => {
    expect(isAuthorizedCronRequest(null, "s3cret")).toBe(false);
    expect(isAuthorizedCronRequest(undefined, "s3cret")).toBe(false);
    expect(isAuthorizedCronRequest("Bearer wrong", "s3cret")).toBe(false);
    expect(isAuthorizedCronRequest("s3cret", "s3cret")).toBe(false);
    expect(isAuthorizedCronRequest("bearer s3cret", "s3cret")).toBe(false);
    expect(isAuthorizedCronRequest("Bearer s3cret ", "s3cret")).toBe(false);
    expect(isAuthorizedCronRequest("Bearer s3cre", "s3cret")).toBe(false);
    expect(isAuthorizedCronRequest("Bearer s3crett", "s3cret")).toBe(false);
  });
});
