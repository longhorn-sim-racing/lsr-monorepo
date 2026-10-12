import { z } from "zod";

/**
 * A UT EID as typed into the profile editor: letters and digits, starting with a letter
 * (e.g. abc1234), stored lowercase. Blank means "remove it".
 */
export const eidInputSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(16, "A UT EID is at most 16 characters.")
  .refine((v) => v === "" || /^[a-z][a-z0-9]+$/.test(v), "A UT EID is letters then numbers, like abc1234.")
  .transform((v) => (v === "" ? null : v));
