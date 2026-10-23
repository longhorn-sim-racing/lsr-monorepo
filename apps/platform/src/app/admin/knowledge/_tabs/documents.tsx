import { DocumentsTab } from "../_documents/documents-tab"
import { TeamsTab } from "../_documents/teams-tab"
import type { KnowledgeTab } from "./types"

/** Knowledge page tabs from the documents track: the synced Drive and SharePoint documents, and Teams messages */
export const TABS: KnowledgeTab[] = [
  { id: "documents", label: "Documents", order: 10, Tab: DocumentsTab },
  { id: "teams", label: "Teams messages", order: 20, Tab: TeamsTab },
]
