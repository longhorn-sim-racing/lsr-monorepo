"use server";

import { requireOfficer } from "@/server/auth/guards";
import { revalidatePath } from "next/cache";
import {
  getFeaturedVideoSettings,
  getSystemSetting,
  setSystemSetting,
  SETTINGS,
  type ClipSettings,
  type FeaturedVideoKind,
  type FeaturedVideoSettings,
  type HotlapSettings,
} from "@/lib/email/settings";
import { videoSource } from "@/lib/featured-video";
import { signVideoUpload } from "@/server/cloudinary";
import { createAuditLog } from "@/server/audit/log";
import type { ActionResult } from "@/lib/action-result";

const BAD_VIDEO = "That video doesn't work here. Upload a video file, or paste a YouTube video link.";

/** Longest a clip's title and its other lines can be */
const TITLE_MAX = 80;
const LINE_MAX = 120;

function field(formData: FormData, name: string) {
  return ((formData.get(name) as string | null) ?? "").trim();
}

function revalidate() {
  revalidatePath("/");
  revalidatePath("/admin/hotlap");
}

export async function getFeaturedVideoForAdmin(): Promise<FeaturedVideoSettings> {
  await requireOfficer();
  return getFeaturedVideoSettings();
}

export async function updateHotlapSettings(formData: FormData): Promise<ActionResult> {
  const user = await requireOfficer();

  const videoUrl = field(formData, "videoUrl");
  const driverName = field(formData, "driverName");
  const car = field(formData, "car");
  const track = field(formData, "track");
  const lapTime = field(formData, "lapTime");

  if (!videoUrl || !driverName || !car || !track || !lapTime) {
    return { ok: false, error: "Fill in every field: video, driver, car, track and lap time." };
  }
  if (!videoSource(videoUrl)) return { ok: false, error: BAD_VIDEO };

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

  revalidate();
  return { ok: true };
}

export async function updateClipSettings(formData: FormData): Promise<ActionResult> {
  const user = await requireOfficer();

  const videoUrl = field(formData, "videoUrl");
  const title = field(formData, "title");
  if (!videoUrl || !title) return { ok: false, error: "Add the video and a title." };
  if (!videoSource(videoUrl)) return { ok: false, error: BAD_VIDEO };
  if (title.length > TITLE_MAX) return { ok: false, error: `Keep the title to ${TITLE_MAX} characters.` };

  const next: ClipSettings = { videoUrl, title };
  for (const key of ["drivers", "race", "credit"] as const) {
    const value = field(formData, key);
    if (value.length > LINE_MAX) return { ok: false, error: `Keep each line to ${LINE_MAX} characters.` };
    if (value) next[key] = value;
  }

  const previous = await getSystemSetting<ClipSettings>(SETTINGS.CLIP);
  await setSystemSetting(SETTINGS.CLIP, next);

  await createAuditLog({
    actorUserId: user.id,
    actionType: "UPDATE",
    entityType: "SYSTEM_SETTING",
    entityId: SETTINGS.CLIP,
    summary: "Updated the competition clip",
    before: previous ?? null,
    after: next,
  });

  revalidate();
  return { ok: true };
}

/** Switch the home page between the hotlap of the week and the competition clip. */
export async function setFeaturedVideo(show: FeaturedVideoKind): Promise<ActionResult> {
  const user = await requireOfficer();
  if (show !== "hotlap" && show !== "clip") return { ok: false, error: "Pick the hotlap or the clip." };

  const current = await getFeaturedVideoSettings();
  if (show === "clip" && !current.clip) return { ok: false, error: "Save a competition clip first." };
  if (current.show === show) return { ok: true };

  await setSystemSetting(SETTINGS.FEATURED_VIDEO, show);

  await createAuditLog({
    actorUserId: user.id,
    actionType: "UPDATE",
    entityType: "SYSTEM_SETTING",
    entityId: SETTINGS.FEATURED_VIDEO,
    summary: show === "clip" ? "Home page video set to the competition clip" : "Home page video set to the hotlap of the week",
    before: { show: current.show },
    after: { show },
  });

  revalidate();
  return { ok: true };
}

/** A signed upload for one video, which the browser sends straight to Cloudinary. */
export async function startVideoUpload(): Promise<ActionResult<NonNullable<ReturnType<typeof signVideoUpload>>>> {
  await requireOfficer();
  const signed = signVideoUpload();
  if (!signed) {
    return { ok: false, error: "Video uploads aren't set up yet. Use a YouTube link, or ask the Tech Team." };
  }
  return { ok: true, data: signed };
}
