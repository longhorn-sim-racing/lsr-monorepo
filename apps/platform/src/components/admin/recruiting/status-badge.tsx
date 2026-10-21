import type { TrackStatus } from "@prisma/client";
import { Badge } from "@/components/admin/kit";
import { TRACK_STATUS_LABEL, TRACK_STATUS_TONE } from "@/lib/recruiting/labels";

export function StatusBadge({ status, className }: { status: TrackStatus; className?: string }) {
  return (
    <Badge tone={TRACK_STATUS_TONE[status]} className={className}>
      {TRACK_STATUS_LABEL[status]}
    </Badge>
  );
}
