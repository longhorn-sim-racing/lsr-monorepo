/**
 * What a server action returns for a problem the user can fix. Return it instead of throwing:
 * production Next.js replaces a thrown error's message with a generic one, so the user never sees it.
 */
export type ActionResult = { ok: true } | { ok: false; error: string };
