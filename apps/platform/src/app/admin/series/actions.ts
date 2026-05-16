"use server"

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSeries as createSeriesInDb, updateSeries as updateSeriesInDb, deleteSeries as deleteSeriesInDb } from "@/server/repos/series.repo";
import { getSeriesById } from "@/server/repos/series.repo";
import { createAuditLog } from "@/server/audit/log";
import { requireOfficer } from "@/server/auth/guards";
import { revalidateSeriesPages, revalidateEventList } from "@/server/cache/revalidate-public";

export async function createSeries(formData: FormData) {
  const user = await requireOfficer();

  const title = formData.get("title") as string;
  const slug = formData.get("slug") as string;

  const series = await createSeriesInDb({
    title,
    slug,
  });

  await createAuditLog({
    actorUserId: user.id,
    actionType: "CREATE",
    entityType: "EVENT_SERIES",
    entityId: series.id,
    summary: `Created series: ${series.title}`,
    after: { title, slug },
  });

  revalidatePath("/admin/series");
  revalidateEventList();
  revalidateSeriesPages(series.slug);
  redirect("/admin/series");
}

export async function updateSeries(id: string, formData: FormData) {
  const user = await requireOfficer();

  const title = formData.get("title") as string;
  const slug = formData.get("slug") as string;

  const prev = await getSeriesById(id);

  await updateSeriesInDb(id, {
    title,
    slug,
  });

  await createAuditLog({
    actorUserId: user.id,
    actionType: "UPDATE",
    entityType: "EVENT_SERIES",
    entityId: id,
    summary: `Updated series: ${title}`,
    after: { title, slug },
  });

  revalidatePath("/admin/series");
  revalidateEventList();
  revalidateSeriesPages(slug);
  if (prev && prev.slug !== slug) revalidateSeriesPages(prev.slug);
  redirect("/admin/series");
}

export async function deleteSeries(id: string) {
  const user = await requireOfficer();

  const prev = await getSeriesById(id);

  await deleteSeriesInDb(id);

  await createAuditLog({
    actorUserId: user.id,
    actionType: "DELETE",
    entityType: "EVENT_SERIES",
    entityId: id,
    summary: `Deleted series ${id}`,
  });

  revalidatePath("/admin/series");
  revalidateEventList();
  if (prev) revalidateSeriesPages(prev.slug);
}
