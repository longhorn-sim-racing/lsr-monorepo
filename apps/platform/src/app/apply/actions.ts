"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/guards";
import { unexpectedError } from "@/lib/action-result";
import type { RecruitingActionResult } from "@/lib/recruiting/action-result";
import { isRecruitingError, saveDraft, setSelectedTracks } from "@/server/services/recruiting.service";
import { submitAndNotify } from "@/server/services/recruiting-email.service";
import { getApplyAvailability } from "@/server/services/recruiting-apply.service";

// Server actions can be called by anyone who can craft a request. Each one:
//  - takes the applicant from the SESSION (no id is accepted from the client, so nobody can touch
//    another person's application),
//  - refuses when applications aren't switched on,
//  - leaves validation of what was typed to the service (which re-checks everything),
//  - returns problems as { ok: false, error } instead of throwing (production hides thrown messages).

async function run<T>(work: (userId: string) => Promise<T>): Promise<RecruitingActionResult<T>> {
  let userId: string;
  try {
    userId = (await requireUser()).id;
  } catch {
    return { ok: false, error: "Sign in to continue.", code: "UNAUTHENTICATED" };
  }

  const availability = await getApplyAvailability();
  if (availability.state === "off" || availability.state === "no-round") {
    return { ok: false, error: "Applications aren't open right now.", code: "CLOSED" };
  }

  try {
    const data = await work(userId);
    revalidatePath("/apply", "layout");
    return { ok: true, data };
  } catch (e) {
    if (isRecruitingError(e)) return { ok: false, error: e.message, fieldErrors: e.fieldErrors, code: e.code, report: e.report };
    console.error("[Apply] Action failed:", e instanceof Error ? e.message : e);
    return { ok: false, error: unexpectedError(e, "We couldn't save that") };
  }
}

/** One page's "Save and continue". `patch` is untrusted: the service validates all of it and writes nothing unless it is all valid. */
export async function saveProgressAction(patch: unknown) {
  return run(async (userId) => {
    await saveDraft(userId, patch);
    return { savedAt: new Date().toISOString() };
  });
}

/** Sets which teams the application is for. Teams that are dropped lose their answers. */
export async function setTeamsAction(teamKeys: unknown) {
  return run(async (userId) => {
    const { added, removed } = await setSelectedTracks(userId, teamKeys);
    return { added, removed };
  });
}

/** Submit: final. A refused submit returns the completeness report so the page can show what is missing. */
export async function submitApplicationAction() {
  return run(async (userId) => {
    const done = await submitAndNotify(userId);
    return { emailStatus: done.delivery?.status ?? null };
  });
}
