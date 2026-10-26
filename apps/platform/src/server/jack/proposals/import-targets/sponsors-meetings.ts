import { actionItemsImportTarget, prospectsImportTarget } from "../sponsors-meetings/import-targets"
import type { AnyImportTarget } from "../types"

/** Import targets from the sponsors-meetings track: where an import.rows proposal can put a file's rows (design §4.3) */
export const IMPORT_TARGETS: AnyImportTarget[] = [prospectsImportTarget, actionItemsImportTarget]
