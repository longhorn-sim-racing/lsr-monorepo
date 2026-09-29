"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { requireOfficer } from "@/server/auth/guards";
import { createAuditLog } from "@/server/audit/log";

const pageSchema = z.object({
  title: z.string().trim().min(1, "Give the page a title.").max(200),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug: lowercase letters, numbers and dashes."),
  visibility: z.enum(["public", "officers"]),
  bodyMd: z.string().max(50_000, "That's too long for one page."),
});

export type PageInput = z.infer<typeof pageSchema>;

type Result = { ok: true; id: string } | { ok: false; error: string };

export async function savePage(id: string | null, input: PageInput): Promise<Result> {
  const user = await requireOfficer();
  const parsed = pageSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form." };

  try {
    const before = id ? await prisma.page.findUnique({ where: { id } }) : null;
    if (id && !before) return { ok: false, error: "Page not found." };

    const page = id
      ? await prisma.page.update({ where: { id }, data: { ...parsed.data, authorId: user.id } })
      : await prisma.page.create({ data: { ...parsed.data, authorId: user.id } });

    await createAuditLog({
      actorUserId: user.id,
      actionType: id ? "UPDATE" : "CREATE",
      entityType: "PAGE",
      entityId: page.id,
      summary: `${id ? "Updated" : "Created"} page: ${page.title}${before && before.visibility !== page.visibility ? ` (${page.visibility === "public" ? "published" : "unpublished"})` : ""}`,
      before: before ?? undefined,
      after: page,
    });

    revalidatePath("/admin/pages");
    revalidatePath("/lone-star-cup");
    revalidatePath("/lone-star-cup/rules");
    return { ok: true, id: page.id };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { ok: false, error: "Another page already uses that slug." };
    }
    return { ok: false, error: error instanceof Error ? error.message : "Couldn't save the page." };
  }
}
