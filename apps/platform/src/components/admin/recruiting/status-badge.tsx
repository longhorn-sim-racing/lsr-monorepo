import type { TrackStatus } from "@prisma/client";
import { cn } from "@/lib/utils";
import { TRACK_STATUS_BADGE, TRACK_STATUS_LABEL } from "@/lib/recruiting/labels";

export function StatusBadge({ status, className }: { status: TrackStatus; className?: string }) {
  return (
    <span className={cn("inline-block whitespace-nowrap rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider", TRACK_STATUS_BADGE[status], className)}>
      {TRACK_STATUS_LABEL[status]}
    </span>
  );
}
