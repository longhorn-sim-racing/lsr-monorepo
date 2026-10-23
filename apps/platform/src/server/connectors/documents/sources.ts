import { googleDriveConnector } from "../google-drive/connector"
import { sharePointConnector } from "../sharepoint/connector"

/**
 * Where synced documents come from (ExternalDocument.source), and the connector behind each. A source
 * whose connector is switched off is left out everywhere documents are read (search, read, the
 * Knowledge page's Documents tab), whatever rows it still has: switching a connector off is how an admin
 * stops Jack seeing it.
 */
export const DOCUMENT_SOURCES = [
  { source: "drive", label: "Google Drive", connector: googleDriveConnector },
  { source: "sharepoint", label: "SharePoint", connector: sharePointConnector },
] as const

export type DocumentSource = (typeof DOCUMENT_SOURCES)[number]["source"]

export const DOCUMENT_SOURCE_LABEL: Record<string, string> = Object.fromEntries(DOCUMENT_SOURCES.map((s) => [s.source, s.label]))

/** The sources whose connector an admin has switched on */
export async function enabledDocumentSources(): Promise<DocumentSource[]> {
  const on = await Promise.all(DOCUMENT_SOURCES.map((s) => s.connector.enabled()))
  return DOCUMENT_SOURCES.filter((_, i) => on[i]).map((s) => s.source)
}
