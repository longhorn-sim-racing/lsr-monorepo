"use server";

import { requireOfficer } from "@/server/auth/guards";
import { createPage, pageSchema, updatePageContent, type PageInput } from "@/server/services/page.service";

export type { PageInput };

type Result = { ok: true; id: string } | { ok: false; error: string };

export async function savePage(id: string | null, input: PageInput): Promise<Result> {
  let user;
  try {
    user = await requireOfficer();
  } catch {
    return { ok: false, error: "You're signed out or no longer an officer. Copy your text, sign in again, and retry." };
  }
  const parsed = pageSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form." };

  // The service keeps the LSC rules slug, writes the audit entry and refreshes the pages that show it
  const result = id
    ? await updatePageContent(id, parsed.data, { actorUserId: user.id })
    : await createPage(parsed.data, { actorUserId: user.id });
  return result.ok ? { ok: true, id: result.page.id } : { ok: false, error: result.error };
}
