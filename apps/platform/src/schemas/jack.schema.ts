import { z } from "zod";
import { FEEDBACK_NOTE_MAX } from "@/lib/jack/feedback";
import { MAX_FILES_PER_MESSAGE } from "@/lib/jack/files";

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

/** A message with files (G5): the text may be empty when files go with it */
export const jackPostSchema = z
  .object({
    roomId: jackRoomIdSchema,
    content: z
      .string()
      .trim()
      .max(JACK_MESSAGE_MAX, `Keep it under ${JACK_MESSAGE_MAX.toLocaleString("en-US")} characters`),
    fileIds: z
      .array(z.uuid("A file you attached is gone. Remove it and attach it again."))
      .max(MAX_FILES_PER_MESSAGE, `Up to ${MAX_FILES_PER_MESSAGE} files per message`)
      .default([]),
  })
  .refine((post) => post.content.length > 0 || post.fileIds.length > 0, { message: "Type a message first", path: ["content"] });

/** What the composer sends to start an upload; the file rules themselves are in lib/jack/files.ts */
export const jackUploadSchema = z.object({
  roomId: jackRoomIdSchema,
  filename: z.string().min(1, "This file has no name").max(1_000, "This file's name is too long"),
  size: z.number().int().nonnegative(),
  type: z.string().max(200).default(""),
});

export const jackFileIdSchema = z.uuid("That file doesn't exist");

export const jackRoomTitleSchema = z
  .string()
  .trim()
  .max(JACK_TITLE_MAX, `Keep the title under ${JACK_TITLE_MAX} characters`)
  .transform((title) => title || null);

export const jackPersonaSwitchSchema = z.object({
  roomId: jackRoomIdSchema,
  persona: z.enum(["jack", "lift", "stand"], "Pick Jack, Lift or Stand"),
});

/** Archive or unarchive, pin or unpin, and mention mode (design §10) */
export const jackRoomArchiveSchema = z.object({ roomId: jackRoomIdSchema, archived: z.boolean() });

export const jackRoomPinSchema = z.object({ roomId: jackRoomIdSchema, pinned: z.boolean() });

export const jackAnswerModeSchema = z.object({
  roomId: jackRoomIdSchema,
  mode: z.enum(["always", "mention"], "Pick every message or mentions only"),
});

/** A thumbs up or down on a reply (null takes it back), with an optional short note */
export const jackFeedbackSchema = z.object({
  messageId: z.uuid("That reply doesn't exist anymore."),
  rating: z.enum(["up", "down"], "Pick thumbs up or down").nullable(),
  note: z
    .string()
    .trim()
    .max(FEEDBACK_NOTE_MAX, `Keep the note under ${FEEDBACK_NOTE_MAX} characters`)
    .nullish()
    .transform((note) => note || null),
});

export const jackRoomRenameSchema = z.object({
  roomId: jackRoomIdSchema,
  title: z
    .string()
    .trim()
    .min(1, "Type a name for the room")
    .max(JACK_TITLE_MAX, `Keep the title under ${JACK_TITLE_MAX} characters`),
});
