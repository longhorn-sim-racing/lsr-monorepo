/**
 * Errors a kind throws to steer the framework (src/server/jack/proposals/service.ts). Anything else a
 * kind throws is unexpected: from prepare() it fails the tool call, from apply() it marks the proposal
 * FAILED with the message, redacted.
 */

/**
 * From prepare(): the input can't make a proposal (no such page, a find that isn't there). The message
 * goes back to the model as the tool's error, so it can fix its input and try again; nothing is saved.
 */
export class ProposalInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProposalInputError"
  }
}

/**
 * From apply(): what the proposal changes moved on between checkStale() and the write (the write's own
 * conditional check missed). The proposal becomes STALE with this message as the reason, not FAILED.
 */
export class StaleProposalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StaleProposalError"
  }
}
