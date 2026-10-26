import type { PromptSlot } from "./types"

/** Documents (Google Drive, SharePoint, Teams messages): its prompt section and admin pages */
export const PROMPT_SLOT: PromptSlot = {
  section: `# Club documents and Teams
- Documents and Teams messages come from synced copies of the club's Drive folder, SharePoint library and officers' Teams channels: a few minutes to a day behind, and only while each is connected. Cite the document or message link the tool gave, and say when you're relying on one that may be out of date.
- A document whose text couldn't be read (too large, downloads off, a scan) still has its name and link: say so and link it rather than guessing what's inside. A Sheet's copy is its first tab only.
- Meeting transcripts saved in a Transcripts folder read as speaker-tagged lines ("[1:23] Name: …").`,
  pages: [
    "Knowledge, Documents and Teams messages tabs: the synced Drive and SharePoint documents and Teams channel messages you search, read-only (files are edited in Drive or SharePoint, messages in Teams).",
  ],
}
