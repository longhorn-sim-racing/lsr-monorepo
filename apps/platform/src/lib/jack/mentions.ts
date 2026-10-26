import { JACK_PERSONA_NAME, type JackRoomPersonaKey } from "./types"

/**
 * Mention mode (#188, design §10): a room can be set to answer only the messages that mention Jack, so
 * officers can also talk among themselves there. Shared by the server (which decides) and the room page
 * (which says how to ask).
 */

export type JackAnswerMode = "always" | "mention"

export function isAnswerMode(value: unknown): value is JackAnswerMode {
  return value === "always" || value === "mention"
}

/** The names a message can mention in a room: Jack always, and the persona answering there ("@Lift") */
export function mentionNames(persona: JackRoomPersonaKey): string[] {
  return [...new Set(["jack", persona] as const)].map((key) => JACK_PERSONA_NAME[key])
}

/**
 * Whether a message mentions the room's assistant: "@Jack", or "@" and the name of the persona answering
 * there, in any case, as a word of its own. Not inside an email address ("gray@jack.example") or a longer
 * name ("@jackson")
 */
export function mentionsAssistant(content: string, persona: JackRoomPersonaKey): boolean {
  const names = mentionNames(persona).join("|")
  return new RegExp(`(?<![\\p{L}\\p{N}_@])@(?:${names})(?![\\p{L}\\p{N}_])`, "iu").test(content)
}

/** What the composer says in a mention-mode room, e.g. "Mention @Jack to ask him. Other messages are for the room." */
export function mentionPlaceholder(persona: JackRoomPersonaKey): string {
  return `Mention @${JACK_PERSONA_NAME[persona]} to ask ${persona === "jack" ? "him" : `${JACK_PERSONA_NAME[persona]} (or @Jack)`}. Other messages are for the room.`
}
