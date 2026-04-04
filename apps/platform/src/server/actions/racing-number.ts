"use server";

import { z } from "zod";
import { prisma } from "@/server/db";
import { requireUser } from "@/server/auth/guards";
import { revalidatePath } from "next/cache";

const schema = z.number().int().min(0).max(999);

export async function setRacingNumberAction(racingNumber: number) {
  const user = await requireUser();

  const parsed = schema.safeParse(racingNumber);
  if (!parsed.success) {
    throw new Error("Invalid racing number. Must be between 0 and 999.");
  }

  // Check uniqueness
  const existing = await prisma.user.findUnique({
    where: { racingNumber: parsed.data },
    select: { id: true },
  });

  if (existing && existing.id !== user.id) {
    throw new Error("This racing number is already reserved by another driver.");
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { racingNumber: parsed.data },
  });

  // Revalidate to hide the prompt
  revalidatePath("/", "layout");
}
