import type { Prisma } from "@prisma/client"

/**
 * The messages a reply answers: officer messages that expect an answer (in a mention-mode room, only the
 * ones that mention Jack, design §10), notes asking Jack to keep going on a deck (#177, answered as the
 * officer who asked), and notes a scheduled run posted (`scheduled`, a recurring question). The reply loop
 * waits on these, and the Usage page counts a reply's cost for whoever posted the one that started it, so
 * both use this one list
 */
export const REPLY_TRIGGERS: Prisma.JackMessageWhereInput[] = [
  { kind: "user", expectsAnswer: true },
  { kind: "system", continues: true },
  { kind: "system", scheduled: true },
]
