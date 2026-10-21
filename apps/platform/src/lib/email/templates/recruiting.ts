/**
 * Recruiting emails: default drafts, placeholder substitution and HTML rendering.
 * Pure functions (no database, no network) so they are easy to test.
 *
 * A draft is plain text with a fixed set of {{placeholders}}. composeEmail() fills them in
 * (one pass, so a value can never introduce a new placeholder) and returns the final plain
 * subject/body, which is exactly what gets stored and sent. renderEmail() turns that text
 * into branded HTML, escaping every character: nothing an applicant or an officer types can
 * become markup. (baseTemplate() inserts its title/body/preview into HTML unescaped, so the
 * escaping has to happen here.)
 */

import { baseTemplate } from "./base";

export type RecruitingEmailTemplate = "RECEIVED" | "INTERVIEW" | "ACCEPTED" | "REJECTED";

export const RECRUITING_TOKENS = [
  "applicantName",
  "trackName", // the one team a decision email is about
  "trackList", // every team applied to (confirmation email)
  "cycleName",
  "schedulingLink", // the team's Google Calendar booking link (interview email)
  "statusUrl", // the applicant's status page
  "replyToEmail",
] as const;
export type RecruitingToken = (typeof RECRUITING_TOKENS)[number];
export type TokenValues = Partial<Record<RecruitingToken, string | null | undefined>>;

export type EmailDraft = { subject: string; body: string };

const TOKEN_PATTERN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const KNOWN = new Set<string>(RECRUITING_TOKENS);

export const LIMITS = { subject: 200, body: 5000, value: 300 } as const;

export type EmailComposeErrorCode = "UNKNOWN_TOKEN" | "MISSING_VALUE" | "EMPTY" | "TOO_LONG";

export class EmailComposeError extends Error {
  code: EmailComposeErrorCode;
  tokens: string[];
  constructor(code: EmailComposeErrorCode, message: string, tokens: string[] = []) {
    super(message);
    this.name = "EmailComposeError";
    this.code = code;
    this.tokens = tokens;
  }
}

/** Names of every {{placeholder}} used in the text, in order, without duplicates. */
export function findTokens(text: string): string[] {
  return [...new Set([...text.matchAll(TOKEN_PATTERN)].map((m) => m[1]))];
}

export function findUnknownTokens(text: string): string[] {
  return findTokens(text).filter((t) => !KNOWN.has(t));
}

// Built from char codes so the source file never contains a raw U+2028/U+2029 (JavaScript treats
// those as line terminators, which would break a regex literal).
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
/** Anything that could break out of a single line: control characters and the Unicode line separators. */
const LINE_BREAKERS = new RegExp(`[\u0000-\u001f\u007f${LS}${PS}]+`, "g");
/** Control characters other than tab and newline (kept in a body), and the Unicode line separators. */
const BODY_JUNK = new RegExp(`[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f${LS}${PS}]`, "g");

/** Values go into one line of text: no line breaks, no control characters, capped length. */
function cleanValue(value: string): string {
  return value.replace(LINE_BREAKERS, " ").replace(/\s+/g, " ").trim().slice(0, LIMITS.value);
}

function cleanSubject(subject: string): string {
  return subject.replace(LINE_BREAKERS, " ").replace(/\s+/g, " ").trim();
}

function cleanBody(body: string): string {
  return body
    .replace(/\r\n?/g, "\n")
    .replace(BODY_JUNK, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Fills the placeholders and returns the final subject and body. Throws EmailComposeError for
 * a placeholder that doesn't exist (a typo), a placeholder with no value (e.g. the team has no
 * booking link), or an empty or oversized subject/body.
 */
export function composeEmail(draft: EmailDraft, values: TokenValues): EmailDraft {
  const unknown = findUnknownTokens(`${draft.subject}\n${draft.body}`);
  if (unknown.length > 0) {
    throw new EmailComposeError("UNKNOWN_TOKEN", `Unknown placeholder: ${unknown.map((t) => `{{${t}}}`).join(", ")}`, unknown);
  }
  const missing = findTokens(`${draft.subject}\n${draft.body}`).filter((t) => !values[t as RecruitingToken]?.trim());
  if (missing.length > 0) {
    throw new EmailComposeError("MISSING_VALUE", `No value for ${missing.map((t) => `{{${t}}}`).join(", ")}`, missing);
  }

  // One pass over the draft: substituted values are never scanned again.
  const fill = (text: string) =>
    text.replace(TOKEN_PATTERN, (_all, name: string) => cleanValue(values[name as RecruitingToken] ?? ""));

  const subject = cleanSubject(fill(draft.subject));
  const body = cleanBody(fill(draft.body));
  if (!subject) throw new EmailComposeError("EMPTY", "The subject is empty.");
  if (!body) throw new EmailComposeError("EMPTY", "The message is empty.");
  if (subject.length > LIMITS.subject) throw new EmailComposeError("TOO_LONG", `The subject is over ${LIMITS.subject} characters.`);
  if (body.length > LIMITS.body) throw new EmailComposeError("TOO_LONG", `The message is over ${LIMITS.body} characters.`);
  return { subject, body };
}

// ---------------------------------------------------------------------------
// Default drafts (officers can edit any of these for one person at send time)
// ---------------------------------------------------------------------------

export type DraftOptions = {
  /** The team has a booking link configured: use it in the interview email. */
  hasSchedulingLink?: boolean;
  /** The deadline sweep submitted it (the applicant never pressed Submit). */
  autoSubmitted?: boolean;
};

const SIGN_OFF = "Longhorn Sim Racing";

export function defaultDraft(template: RecruitingEmailTemplate, options: DraftOptions = {}): EmailDraft {
  switch (template) {
    case "RECEIVED":
      return {
        subject: "We received your application to Longhorn Sim Racing",
        body: [
          "Hi {{applicantName}},",
          "Thanks for applying to Longhorn Sim Racing for {{cycleName}}. We received your application to: {{trackList}}.",
          ...(options.autoSubmitted
            ? ["You hadn't pressed Submit before the round closed, but your application was complete, so we submitted it for you."]
            : []),
          "Officers review applications as they come in. You will get a separate email from each team as decisions are made, and you can see where each one stands at {{statusUrl}}.",
          "Questions? Just reply to this email.",
          SIGN_OFF,
        ].join("\n\n"),
      };
    case "INTERVIEW":
      return {
        subject: "Interview invitation: {{trackName}} at Longhorn Sim Racing",
        body: [
          "Hi {{applicantName}},",
          "Thanks for applying to {{trackName}} for {{cycleName}}. We'd like to invite you to an interview.",
          options.hasSchedulingLink
            ? "Pick a time that works for you here:\n{{schedulingLink}}\n\nIf none of the times work, reply to this email and we'll find another."
            : "Reply to this email and we'll send you a few times that work.",
          SIGN_OFF,
        ].join("\n\n"),
      };
    case "ACCEPTED":
      return {
        subject: "You're in: {{trackName}} at Longhorn Sim Racing",
        body: [
          "Hi {{applicantName}},",
          "Congratulations! We're happy to let you know you've been accepted to {{trackName}} for {{cycleName}}.",
          "A team lead will be in touch soon with next steps. If you have questions in the meantime, just reply to this email.",
          `Welcome to the team,\n${SIGN_OFF}`,
        ].join("\n\n"),
      };
    case "REJECTED":
      return {
        subject: "Your {{trackName}} application at Longhorn Sim Racing",
        body: [
          "Hi {{applicantName}},",
          "Thank you for applying to {{trackName}} for {{cycleName}} and for the time you put into your application. After reviewing applications, we aren't able to offer you a place on this team this round.",
          "We'd love to see you at our events and in future rounds. If you'd like to talk it over, just reply to this email.",
          SIGN_OFF,
        ].join("\n\n"),
      };
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PARAGRAPH_STYLE =
  "margin:0 0 16px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:15px;line-height:1.6;color:#e5e5e5;";

/**
 * Final subject/body (plain text, already composed) to branded HTML + a plain-text version.
 * Paragraphs split on blank lines; single newlines become line breaks. URLs stay as plain
 * text (mail clients link them); nothing is turned into markup.
 */
export function renderEmail(email: EmailDraft): { subject: string; html: string; text: string } {
  const paragraphs = email.body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const bodyHtml = paragraphs
    .map((p) => `<p style="${PARAGRAPH_STYLE}">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");

  const { html } = baseTemplate({
    previewText: escapeHtml((paragraphs[0] ?? "").slice(0, 120)),
    title: escapeHtml(email.subject),
    body: bodyHtml,
    footerText: "Longhorn Sim Racing · UT Austin",
    // Recruiting mail ignores email preferences, so don't offer a way to change them
    hidePreferencesLink: true,
  });

  return {
    subject: email.subject,
    html,
    text: `${email.body}\n\n--\nLonghorn Sim Racing · UT Austin\n`,
  };
}
