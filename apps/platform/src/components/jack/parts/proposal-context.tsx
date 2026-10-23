"use client"

import { createContext, useContext } from "react"
import type { JackProposalState } from "@/lib/jack/types"

/**
 * What a proposal card needs from the room it's in (#188): the room's live proposal statuses (from its
 * snapshot and proposal.updated events) and the Apply and Discard actions. The room page provides it;
 * a card outside a room shows its status without the buttons.
 */
export type ProposalRoom = {
  states: Record<string, JackProposalState>
  /** Resolves with an error to show, or null once applied. `selectedRows`: list kinds only */
  apply: (id: string, selectedRows?: string[]) => Promise<string | null>
  /** Resolves with an error to show, or null once discarded */
  discard: (id: string) => Promise<string | null>
}

export const ProposalRoomContext = createContext<ProposalRoom | null>(null)

export function useProposalRoom(): ProposalRoom | null {
  return useContext(ProposalRoomContext)
}
