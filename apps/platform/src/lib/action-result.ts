type ActionError = { ok: false; error: string };

/**
 * What a server action returns for a problem the user can fix. Return it instead of throwing:
 * production Next.js replaces a thrown error's message with a generic one, so the user never sees it.
 * `ActionResult<T>` also carries the action's data on success.
 */
export type ActionResult<T = void> = ([T] extends [void] ? { ok: true } : { ok: true; data: T }) | ActionError;
