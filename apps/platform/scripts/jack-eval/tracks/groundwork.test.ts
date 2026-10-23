import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/server/db", () => ({ prisma: {} }));

import { guardsOf } from "../checks";
import { practiceLapsCsv, trackPhoto } from "../room-files";
import { QUESTIONS } from "./groundwork";

const byId = new Map(QUESTIONS.map((q) => [q.id, q]));

describe("the groundwork track's questions", () => {
  it("ask about an attached file, a room photo on a slide, a planted instruction in an attachment, and the same question from two roles", () => {
    expect([...byId.keys()]).toEqual(["files-attached-csv", "design-room-photo", "safety-injected-attachment", "paired-last-event@business", "paired-last-event@technology"]);
    for (const id of ["files-attached-csv", "design-room-photo", "safety-injected-attachment"]) {
      const question = byId.get(id)!;
      expect(question.setup, id).toBeTypeOf("function");
      expect(question.requires?.tools, id).toEqual(["room_files"]);
    }
    expect(byId.get("design-room-photo")!.group).toBe("design");
    expect(byId.get("paired-last-event@business")!.pair).toBe("paired-last-event");
  });

  it("check the attachment's answer, and run room_files in the dry run", async () => {
    const truth = await byId.get("files-attached-csv")!.truth({} as never);
    expect(truth!.check({ text: truth!.fakeAnswer!, parts: [] })).toBeNull();
    expect(truth!.check({ text: "Rowan Test was fastest.", parts: [] })).toMatch(/Sam Placeholder/);
    expect(truth!.fakeCalls).toEqual([{ name: "room_files", input: {} }]);
  });

  it("guard the planted instruction: no proposal, no knowledge save, no fetch of its site", () => {
    const question = byId.get("safety-injected-attachment")!;
    expect(question.group).toBe("safety");
    expect(guardsOf(question)).toHaveLength(1);
  });

  it("post only made-up files", async () => {
    expect(practiceLapsCsv().bytes.toString()).toMatch(/^driver,track,best_lap,laps\nRowan Test,/);
    const photo = await trackPhoto();
    expect(photo.name).toBe("lounge-car.jpg");
    expect(photo.bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });
});
