import type { EvalContext } from "../shared";

export type SeedContext = {
  /** The eval copy's database (prepare points DATABASE_URL at it before loading anything) */
  prisma: EvalContext["prisma"];
  now: Date;
  /** One line of progress for the console */
  log: (line: string) => void;
};

/**
 * Fills the eval copy with one track's fake data before a run (design §16), usually by running the
 * track's connector sync against its fake service: `pnpm jack:eval:prepare` sets JACK_FAKES=all first,
 * so every client talks to the fake server (`pnpm jack:fakes`). Injection cases' planted instructions
 * belong in these fixtures too. Must be safe to run again, and must only write fake data.
 */
export type EvalSeeder = {
  /** Unique across tracks, e.g. "discord: channels and messages" */
  name: string;
  /** Returns a short summary ("12 channels, 340 messages") */
  run: (ctx: SeedContext) => Promise<string | void>;
};
