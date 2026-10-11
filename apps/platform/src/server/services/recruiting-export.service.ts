// The officers' CSV export. Callers run requireOfficer() first.

import { prisma } from "@/server/db";
import { createAuditLog } from "@/server/audit/log";
import { buildExportCsv, exportFilename } from "@/lib/recruiting/export";
import { listSubmittedTracksForExport, type TrackListFilters } from "@/server/repos/application.repo";

/**
 * One CSV row per submitted team application in a round (drafts are never included), filtered
 * the same way as the list. Writes an audit entry, because applicants' personal data leaves the
 * system here. Returns null for an unknown round.
 */
export async function exportRound(
  officerId: string,
  cycleSlug: string,
  filters: Omit<TrackListFilters, "cycleId" | "take" | "skip">,
  options: { adminBaseUrl: string; now?: Date },
) {
  const cycle = await prisma.recruitingCycle.findUnique({ where: { slug: cycleSlug }, select: { id: true, slug: true, name: true } });
  if (!cycle) return null;

  const rows = await listSubmittedTracksForExport({ ...filters, cycleId: cycle.id });
  const csv = buildExportCsv(rows, { adminBaseUrl: options.adminBaseUrl });

  await createAuditLog({
    actorUserId: officerId,
    actionType: "RECRUITING_EXPORTED",
    entityType: "RECRUITING_CYCLE",
    entityId: cycle.id,
    summary: `Exported ${rows.length} application row${rows.length === 1 ? "" : "s"} from "${cycle.name}" as CSV`,
    metadata: { rowCount: rows.length, filters: { track: filters.track ?? null, status: filters.status ?? null, autoSubmitted: filters.autoSubmitted ?? null, q: filters.q ?? null } },
  });

  return { csv, filename: exportFilename(cycle.slug, options.now), rowCount: rows.length };
}
