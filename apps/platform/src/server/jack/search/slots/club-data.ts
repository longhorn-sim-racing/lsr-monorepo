import { documentsSource } from "../sources/documents"
import { knowledgeSource } from "../sources/knowledge"
import { roomsSource } from "../sources/rooms"
import { siteSource } from "../sources/site"
import { teamsSource } from "../sources/teams"
import type { SearchSource } from "../types"

/** The club-data track's search sources, in the order `search` lists them (design §7.1) */
export const SOURCES: SearchSource[] = [knowledgeSource, documentsSource, roomsSource, siteSource, teamsSource]
