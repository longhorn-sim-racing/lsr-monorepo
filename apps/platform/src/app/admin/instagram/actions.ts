"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOfficer } from "@/server/auth/guards";
import { createAuditLog } from "@/server/audit/log";
import {
  connectInstagram,
  disconnectInstagram,
  setInstagramPostHidden,
  syncInstagram,
} from "@/server/services/instagram.service";

function revalidateInstagram() {
  revalidatePath("/admin/instagram");
  revalidatePath("/news");
}

/** Store a pasted access token (never logged), then pull the posts straight away. */
export async function connectInstagramAction(token: string) {
  const user = await requireOfficer();
  if (typeof token !== "string") return { ok: false as const, error: "Paste the access token first" };
  let profile;
  try {
    profile = await connectInstagram(token);
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "Couldn't connect" };
  }

  await createAuditLog({
    actorUserId: user.id,
    actionType: "UPDATE",
    entityType: "INSTAGRAM",
    entityId: profile.user_id,
    summary: `Connected Instagram account @${profile.username}`,
  });

  const sync = await syncInstagram();
  revalidateInstagram();
  return { ok: true as const, username: profile.username, sync };
}

export async function syncInstagramAction() {
  await requireOfficer();
  const result = await syncInstagram();
  revalidateInstagram();
  return result;
}

export async function disconnectInstagramAction() {
  const user = await requireOfficer();
  await disconnectInstagram();
  await createAuditLog({
    actorUserId: user.id,
    actionType: "UPDATE",
    entityType: "INSTAGRAM",
    entityId: "instagram",
    summary: "Disconnected the Instagram account",
  });
  revalidateInstagram();
}

const hiddenInput = z.object({ id: z.string().min(1).max(64), hidden: z.boolean() });

export async function setInstagramPostHiddenAction(id: string, hidden: boolean) {
  const user = await requireOfficer();
  const input = hiddenInput.safeParse({ id, hidden });
  if (!input.success) return { ok: false as const, error: "Invalid post" };
  if (!(await setInstagramPostHidden(input.data.id, input.data.hidden))) {
    revalidateInstagram();
    return { ok: false as const, error: "That post was removed from Instagram" };
  }
  await createAuditLog({
    actorUserId: user.id,
    actionType: "UPDATE",
    entityType: "INSTAGRAM_POST",
    entityId: input.data.id,
    summary: `${input.data.hidden ? "Hid" : "Showed"} Instagram post ${input.data.id} on the site`,
  });
  revalidateInstagram();
  return { ok: true as const };
}
