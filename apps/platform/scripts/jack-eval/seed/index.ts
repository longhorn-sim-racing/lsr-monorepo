import { joinSlots, SLOT_TRACKS, type SlotTrack } from "../../../src/lib/slots";
import { SEEDERS as automation } from "./automation";
import { SEEDERS as changes } from "./changes";
import { SEEDERS as clubData } from "./club-data";
import { SEEDERS as decksRooms } from "./decks-rooms";
import { SEEDERS as discordPost } from "./discord-post";
import { SEEDERS as discordRead } from "./discord-read";
import { SEEDERS as documents } from "./documents";
import { SEEDERS as groundwork } from "./groundwork";
import { SEEDERS as memory } from "./memory";
import { SEEDERS as sourcesA } from "./sources-a";
import { SEEDERS as sourcesB } from "./sources-b";
import { SEEDERS as sponsorsMeetings } from "./sponsors-meetings";
import type { EvalSeeder } from "./types";

export type { EvalSeeder, SeedContext } from "./types";

/**
 * Each track's fake-data seeders for the eval copy (design §16), one file per track. A track adds to its
 * own file, never here. `pnpm jack:eval:prepare` runs them in SLOT_TRACKS order.
 */
export const SEED_SLOTS = {
  groundwork,
  "club-data": clubData,
  memory,
  changes,
  "sources-a": sourcesA,
  "sources-b": sourcesB,
  documents,
  "discord-read": discordRead,
  "discord-post": discordPost,
  "decks-rooms": decksRooms,
  "sponsors-meetings": sponsorsMeetings,
  automation,
} satisfies Record<SlotTrack, EvalSeeder[]>;

export type TrackSeeder = EvalSeeder & { track: SlotTrack };

/** The slots' seeders in SLOT_TRACKS order, each tagged with its track. Throws when two share a name */
export function trackSeeders(slots: Partial<Record<SlotTrack, readonly EvalSeeder[]>>): TrackSeeder[] {
  const tagged = Object.fromEntries(
    SLOT_TRACKS.filter((track) => Object.hasOwn(slots, track)).map((track) => [track, slots[track]?.map((s) => ({ ...s, track }))])
  ) as Partial<Record<SlotTrack, TrackSeeder[]>>;
  return joinSlots("eval seeder", tagged, (s) => s.name);
}

export const EVAL_SEEDERS: TrackSeeder[] = trackSeeders(SEED_SLOTS);
