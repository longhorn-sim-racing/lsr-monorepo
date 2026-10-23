import { joinSlots, SLOT_TRACKS, type SlotTrack } from "../../../src/lib/slots";
import type { Question } from "../shared";
import { QUESTIONS as automation } from "./automation";
import { QUESTIONS as changes } from "./changes";
import { QUESTIONS as clubData } from "./club-data";
import { QUESTIONS as decksRooms } from "./decks-rooms";
import { QUESTIONS as discordPost } from "./discord-post";
import { QUESTIONS as discordRead } from "./discord-read";
import { QUESTIONS as documents } from "./documents";
import { QUESTIONS as groundwork } from "./groundwork";
import { QUESTIONS as memory } from "./memory";
import { QUESTIONS as sourcesA } from "./sources-a";
import { QUESTIONS as sourcesB } from "./sources-b";
import { QUESTIONS as sponsorsMeetings } from "./sponsors-meetings";

/**
 * Each track's eval questions (design §16), one file per track like every other registry. A track adds
 * questions to its own file, never here. The eval runs them after the core questions (everyday.ts,
 * behavior.ts, design.ts), and `--track=<track>` runs one track's.
 */
export const QUESTION_SLOTS = {
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
} satisfies Record<SlotTrack, Question[]>;

/** The slots' questions in SLOT_TRACKS order, each tagged with its track. Throws when two share an id */
export function trackQuestions(slots: Partial<Record<SlotTrack, readonly Question[]>>): Question[] {
  // An undefined slot (an import cycle) stays undefined, so joinSlots says so instead of a TypeError here
  const tagged = Object.fromEntries(
    SLOT_TRACKS.filter((track) => Object.hasOwn(slots, track)).map((track) => [track, slots[track]?.map((q) => ({ ...q, track }))])
  ) as Partial<Record<SlotTrack, Question[]>>;
  return joinSlots("eval question", tagged, (q) => q.id);
}

export const TRACK_QUESTIONS: Question[] = trackQuestions(QUESTION_SLOTS);

/** Ids name trace files and show in reports: lowercase letters, digits and dashes, and "@" for paired questions */
const ID = /^[a-z0-9][a-z0-9-]*(@[a-z0-9-]+)?$/;

/** The core questions, then the tracks'. Throws when an id repeats or isn't a plain id */
export function questionSet(core: Question[], tracks: Question[] = TRACK_QUESTIONS): Question[] {
  const seen = new Map<string, string>();
  for (const q of [...core, ...tracks]) {
    const where = q.track ?? "the core questions";
    if (!ID.test(q.id)) throw new Error(`Eval question id "${q.id}" (${where}) must be lowercase letters, digits and dashes`);
    const first = seen.get(q.id);
    if (first) throw new Error(`Duplicate eval question "${q.id}": in ${first} and ${where}`);
    seen.set(q.id, where);
  }
  return [...core, ...tracks];
}
