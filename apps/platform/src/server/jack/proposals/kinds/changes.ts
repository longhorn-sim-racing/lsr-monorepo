import { attendanceCheckinKind } from "../changes/attendance-checkin"
import { eventUpdateKind } from "../changes/event-update"
import { importRowsKind } from "../changes/import-rows"
import { newsCreateKind, newsUpdateKind } from "../changes/news"
import { notificationSendKind } from "../changes/notification-send"
import { resultsImportKind } from "../changes/results-import"
import type { AnyProposalKind } from "../types"

/** Proposal kinds from the changes track (design §4.3). The registry joins every track's kinds in a fixed order. Never import ../registry here (an import cycle); targets come from ../import-targets */
export const KINDS: AnyProposalKind[] = [eventUpdateKind, newsCreateKind, newsUpdateKind, notificationSendKind, resultsImportKind, attendanceCheckinKind, importRowsKind]
