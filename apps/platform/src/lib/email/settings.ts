import { prisma } from "@/server/db";

/**
 * Get a system setting by key.
 * Returns the parsed JSON value or undefined if not found.
 */
export async function getSystemSetting<T = unknown>(key: string): Promise<T | undefined> {
  const setting = await prisma.systemSetting.findUnique({
    where: { key },
  });

  if (!setting) return undefined;

  try {
    return JSON.parse(setting.value) as T;
  } catch {
    return setting.value as T;
  }
}

/**
 * Set a system setting by key.
 * Value is JSON-encoded before storage.
 */
export async function setSystemSetting(key: string, value: unknown): Promise<void> {
  const stringValue = typeof value === "string" ? value : JSON.stringify(value);

  await prisma.systemSetting.upsert({
    where: { key },
    update: { value: stringValue },
    create: { key, value: stringValue },
  });
}

// Default settings keys
export const SETTINGS = {
  EMAIL_ENABLED: "notifications.email.enabled",
  EMAIL_FROM: "notifications.email.from",
  HOTLAP: "homepage.hotlap",
  CLIP: "homepage.clip",
  FEATURED_VIDEO: "homepage.featuredVideo",
} as const;

/** Shape of the hotlap-of-the-week setting stored in SystemSetting. */
export type HotlapSettings = {
  /** A YouTube link, or a video uploaded to Cloudinary (see lib/featured-video.ts) */
  videoUrl: string;
  driverName: string;
  car: string;
  track: string;
  lapTime: string;
};

/** A competition clip for the home page: a highlight from a race, like an overtake or a finish. */
export type ClipSettings = {
  /** A YouTube link, or a video uploaded to Cloudinary (see lib/featured-video.ts) */
  videoUrl: string;
  title: string;
  drivers?: string;
  race?: string;
  /** Who recorded or edited it */
  credit?: string;
};

/** Which video the home page shows. */
export type FeaturedVideo = "hotlap" | "clip";

export type FeaturedVideoSettings = {
  show: FeaturedVideo;
  /** Null until an officer saves one (the home page then shows its built-in hotlap) */
  hotlap: HotlapSettings | null;
  clip: ClipSettings | null;
};

/**
 * The home page video: which one shows, and both saved videos. A clip only shows once one is saved;
 * until then it's the hotlap.
 */
export async function getFeaturedVideoSettings(): Promise<FeaturedVideoSettings> {
  const [show, hotlap, clip] = await Promise.all([
    getSystemSetting<string>(SETTINGS.FEATURED_VIDEO),
    getSystemSetting<HotlapSettings>(SETTINGS.HOTLAP),
    getSystemSetting<ClipSettings>(SETTINGS.CLIP),
  ]);
  return { show: show === "clip" && clip ? "clip" : "hotlap", hotlap: hotlap ?? null, clip: clip ?? null };
}

/**
 * Check if email notifications are enabled globally.
 */
export async function isEmailEnabled(): Promise<boolean> {
  const enabled = await getSystemSetting<boolean>(SETTINGS.EMAIL_ENABLED);
  // Default to true if not set
  return enabled ?? true;
}

/**
 * Get the "from" address for notification emails.
 */
export async function getEmailFromAddress(): Promise<string> {
  const from = await getSystemSetting<string>(SETTINGS.EMAIL_FROM);
  return from ?? "Longhorn Sim Racing <noreply@notify.longhornsimracing.org>";
}
