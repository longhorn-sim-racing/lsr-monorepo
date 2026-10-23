import { actionItemUpdateKind } from "../sponsors-meetings/action-item-update"
import { meetingRecordKind } from "../sponsors-meetings/meeting-record"
import { prospectActivityKind } from "../sponsors-meetings/prospect-activity"
import { prospectUpsertKind } from "../sponsors-meetings/prospect-upsert"
import type { AnyProposalKind } from "../types"

/** Proposal kinds from the sponsors-meetings track (design §4.3). The registry joins every track's kinds in a fixed order. Never import ../registry here (an import cycle); targets come from ../import-targets */
export const KINDS: AnyProposalKind[] = [meetingRecordKind, prospectUpsertKind, prospectActivityKind, actionItemUpdateKind]
