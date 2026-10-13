"use server";

import { requireOfficer } from "@/server/auth/guards";
import { prisma } from "@/server/db";
import { revalidatePath } from "next/cache";
import { createAuditLog } from "@/server/audit/log";

export async function updateDriverMapping(id: string, userId: string | null) {
  const user = await requireOfficer();

  const identity = await prisma.driverIdentity.update({
    where: { id },
    data: { userId },
  });

  // Cascade update to existing race participants for this driver
  await prisma.raceParticipant.updateMany({
    where: { driverGuid: identity.driverGuid },
    data: { userId },
  });

  await createAuditLog({
    actorUserId: user.id,
    actionType: "UPDATE",
    entityType: "DRIVER_IDENTITY",
    entityId: id,
    targetUserId: userId,
    summary: `Mapped driver GUID ${identity.driverGuid} to user ${userId || "NULL"}`,
    after: { userId },
  });

  revalidatePath("/admin/drivers");
}
