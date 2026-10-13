import { z } from "zod";

export const JACK_MESSAGE_MAX = 8_000;
export const JACK_TITLE_MAX = 120;

export const jackRoomIdSchema = z.uuid("That room doesn't exist");

export const jackMessageSchema = z.object({
  roomId: jackRoomIdSchema,
  content: z
    .string()
    .trim()
    .min(1, "Type a message first")
    .max(JACK_MESSAGE_MAX, `Keep it under ${JACK_MESSAGE_MAX.toLocaleString("en-US")} characters`),
});

export const jackRoomTitleSchema = z
  .string()
  .trim()
  .max(JACK_TITLE_MAX, `Keep the title under ${JACK_TITLE_MAX} characters`)
  .transform((title) => title || null);
