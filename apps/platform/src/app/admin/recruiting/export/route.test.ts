import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const guards = vi.hoisted(() => ({ requireOfficer: vi.fn() }));
const exporter = vi.hoisted(() => ({ exportRound: vi.fn() }));
vi.mock("@/server/auth/guards", () => guards);
vi.mock("@/server/services/recruiting-export.service", () => exporter);

import { tracks } from "@/schemas/recruiting.schema";
import { GET } from "./route";

const call = (query: string) => GET(new NextRequest(`https://example.org/admin/recruiting/export${query}`));

beforeEach(() => {
  guards.requireOfficer.mockResolvedValue({ id: "officer-1" });
  exporter.exportRound.mockResolvedValue({ csv: "﻿Name\r\n", filename: "lsr-recruiting-fall-2026-2026-10-16.csv", rowCount: 0 });
});

describe("GET /admin/recruiting/export", () => {
  it("is for officers only", async () => {
    guards.requireOfficer.mockRejectedValue(new Error("NotAuthorized"));
    const res = await call("?cycle=fall-2026");
    expect(res.status).toBe(403);
    expect(exporter.exportRound).not.toHaveBeenCalled();
  });

  it("needs a round, and reports an unknown one", async () => {
    expect((await call("")).status).toBe(400);
    exporter.exportRound.mockResolvedValue(null);
    expect((await call("?cycle=nope")).status).toBe(404);
  });

  it("downloads a CSV that is never cached, named after the round", async () => {
    const res = await call("?cycle=fall-2026");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="lsr-recruiting-fall-2026-2026-10-16.csv"');
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await res.text()).replace(/^﻿/, "")).toBe("Name\r\n");
  });

  it("passes the officer's id and the filters to the exporter", async () => {
    const team = tracks[0].key;
    await call(`?cycle=fall-2026&team=${team}&status=INTERVIEW&q=%20ada%20&auto=1`);
    expect(exporter.exportRound).toHaveBeenCalledWith(
      "officer-1",
      "fall-2026",
      { track: team, status: "INTERVIEW", autoSubmitted: true, q: "ada" },
      expect.objectContaining({ adminBaseUrl: expect.stringMatching(/^https?:\/\//) }),
    );
  });

  it("ignores filters it doesn't recognize instead of passing them on", async () => {
    await call("?cycle=fall-2026&team=not-a-team&status=WAITLISTED&auto=yes&q=");
    expect(exporter.exportRound).toHaveBeenCalledWith("officer-1", "fall-2026", { track: undefined, status: undefined, autoSubmitted: undefined, q: undefined }, expect.anything());
  });

  it("caps the search text", async () => {
    await call(`?cycle=fall-2026&q=${"a".repeat(500)}`);
    expect(exporter.exportRound.mock.calls[0][2].q).toHaveLength(100);
  });
});
