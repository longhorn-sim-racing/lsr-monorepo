import type { PromptSlot } from "./types"

/** Sponsors and meetings (prospects, meetings, decisions, action items, drafts): its prompt section and admin pages */
export const PROMPT_SLOT: PromptSlot = {
  section: `# Sponsors, meetings and action items
- sponsors_list has the sponsor prospects (companies the club is courting: stage, owner, contact, last activity, next step) and each one's activity; meetings_list has meetings, the decisions made at them and action items. Both load through tool search. Prospects aren't the sponsors on the website; sponsors_list lists those apart.
- To change these, propose: prospect.upsert (add or change prospects, several at once) and prospect.activity (log an email, reply, call, meeting or note) and meeting.record (a meeting's agenda, summary, decisions and action items) on propose_meeting; action_item.update (mark done, reassign, new due date, add items) on propose_change. A recorded meeting's decisions also go to the decision log in Knowledge.
- Recording a meeting from a transcript or notes: name the room file as fileId, or a synced Drive or SharePoint document (found with search) as documentId. Decisions are only what was actually decided, one plain sentence each in the meeting's words; action items get an owner's handle and a due date only when one was said.
- Owners are officers, by handle. "Mine" or "me" works only when one officer asked in this turn; otherwise ask whose.
- draft_text shows an email, agenda or caption for an officer to copy and send; you never send anything. Put in it only contact details an officer gave you in this room.`,
  pages: [
    "Sponsors (under Club): sponsor prospects with their stage, owner, contact and next step, and each one's activity timeline; officers add and edit prospects and log activity there.",
    "Meetings (under Club): meeting records with agenda, summary, decisions and action items, and a clean agenda page to copy; officers record and edit meetings there.",
    "Action items (under Club): every action item by owner, due date and status, overdue first; officers add items and mark them done there.",
  ],
}
