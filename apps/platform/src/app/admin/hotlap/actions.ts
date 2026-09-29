"use server";

import { requireOfficer } from "@/server/auth/guards";
import { revalidatePath } from "next/cache";
import {
  getSystemSetting,
  setSystemSetting,
  SETTINGS,
  type HotlapSettings,
} from "@/lib/email/settings";
import { createAuditLog } from "@/server/audit/log";

export async function getHotlapSettings(): Promise<HotlapSettings | null> {
  await requireOfficer();
  const data = await getSystemSetting<HotlapSettings>(SETTINGS.HOTLAP);
  return data ?? null;
}

export async function updateHotlapSettings(formData: FormData) {
  const user = await requireOfficer();

  const videoUrl = (formData.get("videoUrl") as string)?.trim();
  const driverName = (formData.get("driverName") as string)?.trim();
  const car = (formData.get("car") as string)?.trim();
  const track = (formData.get("track") as string)?.trim();
  const lapTime = (formData.get("lapTime") as string)?.trim();

  if (!videoUrl || !driverName || !car || !track || !lapTime) {
    throw new Error("All fields are required");
  }

  const previous = await getSystemSetting<HotlapSettings>(SETTINGS.HOTLAP);

  const next: HotlapSettings = { videoUrl, driverName, car, track, lapTime };
  await setSystemSetting(SETTINGS.HOTLAP, next);

  await createAuditLog({
    actorUserId: user.id,
    actionType: "UPDATE",
    entityType: "SYSTEM_SETTING",
    entityId: SETTINGS.HOTLAP,
    summary: `Updated hotlap of the week`,
    before: previous ?? null,
    after: next,
  });

  revalidatePath("/");
  revalidatePath("/admin/hotlap");
}
