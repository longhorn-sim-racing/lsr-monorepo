import { describe, expect, it } from "vitest";
import { SLOT_TRACKS } from "../../../src/lib/slots";
import { EVAL_SEEDERS, SEED_SLOTS, trackSeeders } from "./index";
import type { EvalSeeder } from "./types";

const seeder = (name: string): EvalSeeder => ({ name, run: async () => "done" });

describe("the eval seeder slots", () => {
  it("have one slot per track, each seeder tagged with its slot's track", () => {
    expect(Object.keys(SEED_SLOTS).sort()).toEqual([...SLOT_TRACKS].sort());
    expect(EVAL_SEEDERS).toEqual(SLOT_TRACKS.flatMap((track) => SEED_SLOTS[track].map((seeder) => ({ ...seeder, track }))));
  });

  it("join in track order, each tagged with its track", () => {
    const joined = trackSeeders({ "discord-read": [seeder("discord: channels")], "sources-a": [seeder("stripe: payouts"), seeder("resend: events")] });
    expect(joined.map((s) => `${s.track}/${s.name}`)).toEqual(["sources-a/stripe: payouts", "sources-a/resend: events", "discord-read/discord: channels"]);
  });

  it("throw when two share a name", () => {
    expect(() => trackSeeders({ documents: [seeder("drive")], "sources-b": [seeder("drive")] })).toThrow('Duplicate eval seeder "drive": registered by sources-b and documents');
  });
});
