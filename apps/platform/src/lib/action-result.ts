type ActionError = { ok: false; error: string };

/**
 * What a server action returns for a problem the user can fix. Return it instead of throwing:
 * production Next.js replaces a thrown error's message with a generic one, so the user never sees it.
 * `ActionResult<T>` also carries the action's data on success.
 */
export type ActionResult<T = void> = ([T] extends [void] ? { ok: true } : { ok: true; data: T }) | ActionError;

/**
 * What a form shows when an action throws unexpectedly (a bug, a timeout, a lost connection).
 * Production hides the real message, so say it's on our side; in development show the message.
 */
export function unexpectedError(error: unknown, what = "That didn't work"): string {
  if (process.env.NODE_ENV !== "production" && error instanceof Error) return `${what}: ${error.message}`;
  return `${what}. Something went wrong on our side; try again, and tell the Tech Team if it keeps happening.`;
}
