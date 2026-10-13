import type { RawResultUploadStatus } from "@prisma/client"
import type { Tone } from "@/components/admin/kit"

export const STATUS_LABEL: Record<RawResultUploadStatus, string> = {
  UPLOADED: "Uploaded",
  PARSED: "Parsed",
  INGESTED: "Ingested",
  FAILED: "Failed",
}

export const STATUS_TONE: Record<RawResultUploadStatus, Tone> = {
  UPLOADED: "neutral",
  PARSED: "info",
  INGESTED: "success",
  FAILED: "danger",
}

export const SESSION_LABEL: Record<string, string> = { PRACTICE: "Practice", QUALIFYING: "Qualifying", RACE: "Race" }

export const POINTS_LABEL: Record<string, string> = { F1: "F1 points", HALF: "Half points", NONE: "No points" }

/** 1536 → "1.5 KB" */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
