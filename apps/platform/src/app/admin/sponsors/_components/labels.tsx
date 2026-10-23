import { Badge } from "@/components/admin/kit"
import { PROSPECT_STAGE_LABEL, PROSPECT_STAGE_TONE, type ProspectStage } from "@/lib/sponsor-prospects"

/** A prospect's stage as a pill */
export function StageBadge({ stage }: { stage: string }) {
  const known = stage in PROSPECT_STAGE_LABEL
  return <Badge tone={known ? PROSPECT_STAGE_TONE[stage as ProspectStage] : "neutral"}>{known ? PROSPECT_STAGE_LABEL[stage as ProspectStage] : stage}</Badge>
}

/** A website's host, for a link's text ("acme.com") */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}
