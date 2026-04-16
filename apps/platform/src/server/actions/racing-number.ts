"use server";

import { z } from "zod";
import { prisma } from "@/server/db";
import { requireUser } from "@/server/auth/guards";
import { revalidatePath } from "next/cache";

const schema = z.object({
  racingNumber: z.number().int().min(0).max(999),
  racingNumberColor: z.string().optional().default("#FFFFFF"),
  racingNumberFont: z.string().optional().default("sans-serif"),
  racingNumberItalic: z.boolean().optional().default(false),
  racingNumberBorder: z.boolean().optional().default(false),
});

export async function setRacingNumberAction(input: z.infer<typeof schema>) {
  const user = await requireUser();

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new Error("Invalid racing number data.");
  }

  // Check uniqueness
  const existing = await prisma.user.findUnique({
    where: { racingNumber: parsed.data.racingNumber },
    select: { id: true },
  });

  if (existing && existing.id !== user.id) {
    throw new Error("This racing number is already reserved by another driver.");
  }

  try {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        racingNumber: parsed.data.racingNumber,
        racingNumberColor: parsed.data.racingNumberColor,
        racingNumberFont: parsed.data.racingNumberFont,
        racingNumberItalic: parsed.data.racingNumberItalic,
        racingNumberBorder: parsed.data.racingNumberBorder,
      },
    });
  } catch (error: any) {
    if (error.code === "P2002") {
      throw new Error("This racing number is already reserved by another driver.");
    }
    throw error;
  }

  // Revalidate to hide the prompt
  revalidatePath("/", "layout");
}
