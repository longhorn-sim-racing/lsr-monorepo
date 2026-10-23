"use server";

import { requireOfficer } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { revalidatePath } from "next/cache";
import { createAuditLog } from "@/server/audit/log";
import { revalidatePaths } from "@/server/cache/revalidate-public";
import * as results from "@/server/services/results.service";
import type { ActionResult } from "@/lib/action-result";

export async function uploadResult(formData: FormData) {
  const user = await requireOfficer();

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false as const, error: "Choose a results file to upload." };
  }

  const result = await results.createUpload({ filename: file.name, bytes: await file.arrayBuffer() }, { userId: user.id });
  if (!result.ok) return { ok: false as const, error: result.error };

  revalidatePaths(result.revalidate);

  // Only what the page needs: the row holds the whole file and the uploader's account
  return { ok: true as const, data: { id: result.upload.id, status: result.upload.status } };
}

export async function previewParseResult(uploadId: string) {
  const user = await requireOfficer();

  const result = await results.parseUpload(uploadId, { write: true, actor: { userId: user.id } });
  if (!result.ok) return { ok: false as const, error: result.error };

  revalidatePaths(result.revalidate);

  return { ok: true as const, data: { id: result.upload.id, status: result.upload.status } };
}

export async function bindEventToUpload(
  uploadId: string,
  eventId: string,
  pointsSystem: string | null = null,
  sessionLabel: string | null = null,
): Promise<ActionResult> {
  const user = await requireOfficer();

  const result = await results.bindUpload({ uploadId, eventId, pointsSystem, sessionLabel }, { userId: user.id });
  if (!result.ok) return result;

  revalidatePaths(result.revalidate);
  return { ok: true };
}

export async function deleteUpload(uploadId: string, force: boolean = false): Promise<ActionResult> {
  const user = await requireOfficer();

  const upload = await prisma.rawResultUpload.findUnique({
    where: { id: uploadId },
    include: { ingestedSessions: true },
  });

  if (!upload) return { ok: false, error: "That upload was already deleted." };

  if (upload.ingestedSessions.length > 0 && !force) {
    return { ok: false, error: "These results are already ingested. Use the force delete to remove them and their race records." };
  }

  await prisma.rawResultUpload.delete({
    where: { id: uploadId },
  });

  await createAuditLog({
    actorUserId: user.id,
    actionType: "DELETE",
    entityType: "RESULT_UPLOAD",
    entityId: uploadId,
    summary: `Deleted result upload ${upload.filename}`,
  });

  revalidatePath("/admin/results");
  return { ok: true };
}

export async function ingestUpload(uploadId: string): Promise<ActionResult> {
  const user = await requireOfficer();

  const result = await results.ingestUpload(uploadId, { userId: user.id });
  if (!result.ok) return result;

  revalidatePaths(result.revalidate);
  return { ok: true };
}
