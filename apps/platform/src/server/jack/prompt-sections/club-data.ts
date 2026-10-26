import type { PromptSlot } from "./types"

/** Club data (search and read across sources, recruiting, race performance): its prompt section and admin pages */
export const PROMPT_SLOT: PromptSlot = {
  section: `# Searching the club's records
- search covers knowledge entries, Drive and SharePoint documents, what officers wrote in rooms (and the rooms' notes), the public site and Teams. Use it for decisions, how-tos, past discussions and anything the club wrote down, and search before saying there's no record of something. Then read what you use: read takes a result's type and id and returns a long text a page at a time (read again from nextOffset), or only the passages that match a query. read also opens any public page of the club site by its path (type site_page). Read the site's pages and news posts (the LSC rules, say) this way rather than with run_sql, which cuts long text short and gives no link.
- Cite what you use with the link the tool gave. A result labelled "Jack's earlier answer (not a source)" is only a lead: check it against the data before you repeat it, and never cite it.
- recruiting_pipeline (rounds, applications by team and status, reviews, scores, reviewer load) and race_performance (lap times, consistency, incidents, positions gained, trends, head-to-heads) load through tool search. Applications from officers and admins show only that they applied; never try to work out their reviews or decisions another way. When race_performance's data limits matter to an answer (no DNF is recorded), say so.`,
  pages: ["Recruiting: recruiting rounds, applications by team, reviews and decisions, and recruiting emails."],
}
