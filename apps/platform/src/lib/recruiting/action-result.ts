/**
 * What the recruiting server actions return. Like `ActionResult` (return a problem, don't throw it:
 * production replaces a thrown error's message with a generic one), plus per-field messages so a
 * form can show them next to the right input, and a `code` (a RecruitingError code such as
 * "EMAIL_LIMIT") for the few cases where the page offers a different next step.
 */
export type RecruitingActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string>; code?: string };
