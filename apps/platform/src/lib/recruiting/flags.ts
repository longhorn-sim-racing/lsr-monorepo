import { cache } from "react";
import { prisma } from "@/server/db";

/** FeatureFlag key that gates the whole applicant side of recruiting (/apply/start and the nav link). */
export const RECRUITING_FLAG_KEY = "recruiting";

/**
 * Is recruiting switched on? Defaults to false when the flag row doesn't exist, so
 * shipping the code never exposes anything by itself. Cached per request.
 */
export const isRecruitingEnabled = cache(async (): Promise<boolean> => {
  const flag = await prisma.featureFlag.findUnique({
    where: { key: RECRUITING_FLAG_KEY },
    select: { enabled: true },
  });
  return flag?.enabled ?? false;
});
