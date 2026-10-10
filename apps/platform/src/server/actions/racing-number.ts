"use server";

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { requireUser } from "@/server/auth/guards";
import { revalidatePath } from "next/cache";
import { RACING_NUMBER_COLOR, RACING_NUMBER_FONTS } from "@/lib/racing-number";
import type { ActionResult } from "@/lib/action-result";

const schema = z.object({
  racingNumber: z.number().int().min(0).max(999),
  // These end up in inline styles on public pages, so only accept what the picker offers.
  racingNumberColor: z.string().regex(RACING_NUMBER_COLOR).optional().default("#FFFFFF"),
  racingNumberFont: z
    .string()
    .refine((f) => RACING_NUMBER_FONTS.some((o) => o.value === f))
    .optional()
    .default("sans-serif"),
  racingNumberItalic: z.boolean().optional().default(false),
  racingNumberBorder: z.boolean().optional().default(false),
});

export async function setRacingNumberAction(input: z.infer<typeof schema>): Promise<ActionResult> {
  const user = await requireUser();

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Pick a number from 0 to 999 and a style from the list." };
  }

  // Check uniqueness
  const existing = await prisma.user.findUnique({
    where: { racingNumber: parsed.data.racingNumber },
    select: { id: true },
  });

  if (existing && existing.id !== user.id) {
    return { ok: false, error: "That number is already taken by another driver. Pick a different one." };
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
  } catch (error) {
    // Unique constraint: someone claimed the number between the check above and this write.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { ok: false, error: "That number is already taken by another driver. Pick a different one." };
    }
    throw error;
  }

  // Revalidate to hide the prompt
  revalidatePath("/", "layout");
  return { ok: true };
}
