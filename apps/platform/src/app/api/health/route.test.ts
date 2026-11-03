import { afterEach, beforeEach, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ $queryRaw: vi.fn() }));
vi.mock("@/server/db", () => ({ prisma: db }));

import { GET } from "./route";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("returns an uncached 200 after checking the database on every request", async () => {
  db.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  for (let i = 0; i < 2; i++) {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  expect(db.$queryRaw).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("returns an uncached 503 without exposing database errors", async () => {
  db.$queryRaw.mockRejectedValue(new Error("Connection failed: postgres://private-credentials"));
  const response = await GET();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ status: "unavailable" });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(vi.getTimerCount()).toBe(0);
});

it("returns 503 after five seconds even if the database has not responded", async () => {
  let rejectQuery!: (reason: Error) => void;
  db.$queryRaw.mockReturnValue(new Promise((_, reject) => { rejectQuery = reject; }));
  const pending = GET();
  await vi.advanceTimersByTimeAsync(5_000);
  const response = await pending;
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ status: "unavailable" });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(vi.getTimerCount()).toBe(0);
  // A query that fails after the HTTP deadline must not produce an unhandled rejection.
  rejectQuery(new Error("Pool eventually timed out"));
  await vi.advanceTimersByTimeAsync(0);
});

it("recovers on the next request after an outage", async () => {
  db.$queryRaw.mockRejectedValueOnce(new Error("Database unavailable"));
  expect((await GET()).status).toBe(503);
  db.$queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);
  const response = await GET();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});
