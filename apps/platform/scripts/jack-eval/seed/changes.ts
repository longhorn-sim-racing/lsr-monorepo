import type { EvalSeeder } from "./types";

/** Fills the eval copy with the changes track's fake data before a run (pnpm jack:eval:prepare). Must be safe to run again */
export const SEEDERS: EvalSeeder[] = [];
