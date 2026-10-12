import { PLACEHOLDER_CONTENT } from "@/schemas/recruiting.schema";

/**
 * True while the questions are still placeholders AND this is the real production site. Applicants
 * must never see placeholder teams or questions, so /apply stays closed there until
 * PLACEHOLDER_CONTENT is set to false (launch checklist). Local development and Vercel previews are
 * not blocked, so the form can be built and tested with the placeholders.
 */
export function launchBlocked(placeholder: boolean = PLACEHOLDER_CONTENT, env: Record<string, string | undefined> = process.env): boolean {
  return placeholder && env.VERCEL_ENV === "production";
}
