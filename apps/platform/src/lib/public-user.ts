import type { Prisma } from "@prisma/client";
import { racingNumberSelect } from "@/lib/racing-number";

/**
 * The user fields a public page may load. Anything handed to a client component ends up
 * in the page's HTML, so never add email, eid or other private fields here; select them
 * separately where an officer-only page needs them.
 */
export const publicUserSelect = {
  id: true,
  handle: true,
  displayName: true,
  avatarUrl: true,
  ...racingNumberSelect,
} satisfies Prisma.UserSelect;

export type PublicUser = Prisma.UserGetPayload<{ select: typeof publicUserSelect }>;
