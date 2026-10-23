/**
 * Keeping secrets out of what we store and show (Jack 2.0 design §1 principle 8, §9). Connector and job
 * errors, configs and cursors go through redactSecrets() before they're written, and the knowledge tool
 * refuses a save when looksLikeSecret() finds one.
 *
 * Both are checks by shape: the live values of the env vars below, plus keys, tokens and links that
 * look like secrets. They catch the common leaks, not every possible secret. redactSecrets is lossy on
 * purpose (it drops every query string, for one), so don't run it over a cursor that has to be sent
 * back as is, such as a delta link.
 */

/** Env vars whose values are secrets: wherever one's value shows up, it's masked */
export const SECRET_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_READONLY_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_TEST_SECRET_KEY",
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
  "SUPABASE_SERVICE_ROLE_KEY",
  "CRON_SECRET",
  "SCHEDULER_SIGNING_SECRET",
  "SCHEDULER_SIGNING_SECRET_PREVIOUS",
  "DISCORD_BOT_TOKEN",
  "DISCORD_CLIENT_SECRET",
  "TWITCH_CLIENT_SECRET",
  "TWITCH_EVENTSUB_SECRET",
  "VERCEL_ANALYTICS_TOKEN",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "MS_CLIENT_SECRET",
  "MS_GRAPH_CLIENT_STATE",
  "TEAMS_WEBHOOK_URL",
  "CLOUDINARY_API_SECRET",
  "BLOB_READ_WRITE_TOKEN",
  "SHOPIFY_STOREFRONT_ACCESS_TOKEN",
  "JACK_DATABASE_URL",
  "DATABASE_URL",
  "DIRECT_URL",
] as const

/** The longest text redactSecrets returns by default */
export const REDACT_MAX_CHARS = 2_000

/** The longest text findSecret checks; anything longer counts as unsafe rather than going unchecked */
export const FIND_SECRET_MAX_CHARS = 100_000

export type RedactOptions = {
  /** Env vars whose values are masked (default SECRET_ENV_VARS) */
  envVars?: readonly string[]
  /** Where their values come from (default process.env) */
  env?: Record<string, string | undefined>
  /** The longest result, in characters (default REDACT_MAX_CHARS) */
  maxLength?: number
}

const MASK = "[redacted]"
/**
 * Shorter env values aren't masked: a local placeholder like "dev", or local Supabase's database
 * password "postgres", would mask every "dev" or "postgres" in the text
 */
const MIN_ENV_VALUE_CHARS = 12
/** Text past the result's length that's still redacted before the cut, so no secret is cut in half first */
const REDACT_MARGIN_CHARS = 10_000

/**
 * Links with a scheme (https://, postgresql://, …), up to whitespace, a quote or an angle bracket. The
 * scheme starts only where a run of scheme characters starts, so a long "a.b.c…" can't take seconds
 */
const LINK = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi
/** Punctuation after a link that belongs to the sentence, not the link */
const LINK_TRAILING = /[)\].,;:!?]+$/
/** A link's scheme and host (with any user:password@), and the rest */
const LINK_PARTS = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/i
/** A link with a password in it (user:password@host) */
const LINK_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/?#@:]*:[^/?#@]+@/i

const PEM = /-----BEGIN [A-Z0-9 ]*-----[\s\S]*?(?:-----END [A-Z0-9 ]*-----|$)/g

const hasDigit = (s: string) => /\d/.test(s)

/**
 * Keys and tokens by shape. With `keeps`, the pattern's first group is left in place (the "Bearer "
 * before a token) and only the rest is masked. `when` decides on the masked part, for shapes that
 * ordinary words can take ("re_registration_open", "Basic Membership"). A pattern that can start inside
 * a run starts only where the run starts, so a long run can't make it slow.
 */
const KEY_RULES: { kind: string; pattern: RegExp; keeps?: true; when?: (secret: string) => boolean }[] = [
  { kind: "a Stripe key", pattern: /\b(?:sk|rk)_[A-Za-z0-9_]{12,}/g, when: hasDigit },
  { kind: "a webhook signing secret", pattern: /\bwhsec_[A-Za-z0-9+/=_-]{8,}/g },
  { kind: "an API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, when: hasDigit },
  { kind: "a Resend key", pattern: /\bre_[A-Za-z0-9_]{16,}/g, when: hasDigit },
  { kind: "a Vercel token", pattern: /\bvc[a-z]_[A-Za-z0-9_-]{16,}/g, when: hasDigit },
  { kind: "a Google API key", pattern: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g },
  { kind: "a Discord webhook link", pattern: /(\bdiscord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/)[A-Za-z0-9_-]{20,}/gi, keeps: true },
  { kind: "a bot token", pattern: /(\bBot\s+)[A-Za-z0-9._-]{20,}/g, keeps: true },
  // "Bearer authentication" and "Basic Membership" are prose: a token has a digit
  { kind: "a bearer token", pattern: /(\bBearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, keeps: true, when: hasDigit },
  { kind: "a basic auth credential", pattern: /(\bBasic\s+)[A-Za-z0-9+/]{8,}={0,2}/gi, keeps: true, when: hasDigit },
  { kind: "a JWT", pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g },
  // Discord's bot token shape (three dot-separated parts), with or without "Bot "
  { kind: "a token", pattern: /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{27,}/g },
  // A long token right after a secret-ish label, even all lowercase (Twitch's are 30 lowercase characters)
  {
    kind: "a token",
    pattern: /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]*(?:password|passwd|passphrase|secret|token|key)["']?\s*(?:is\s+|[:=]\s*)?["']?)[A-Za-z0-9]{30,}(?![A-Za-z0-9])/gi,
    keeps: true,
    when: (token) => hasDigit(token) && /[a-z]/i.test(token),
  },
]

/** Names that hold a secret, in `NAME=value`, `name: value` or a quoted `"name": "value"` */
const SECRET_NAME = String.raw`[A-Za-z0-9_-]*(?:password|passwd|passphrase|secret|token|api[_-]?key|private[_-]?key)`
const ASSIGNMENT = new RegExp(String.raw`(["']?)(?<![A-Za-z0-9_-])(${SECRET_NAME})\1(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s"',;&}]+)`, "gi")

/** Hex tokens and hashes, 32 characters or more */
const HEX_RUN = /(?<![A-Za-z0-9])[0-9a-fA-F]{32,}(?![A-Za-z0-9])/g
/**
 * Runs of base64 and base64url characters, 24 or more. A run counts as a secret only when it looks
 * random (isRandomRun), which a file name or a path made of words doesn't
 */
const RUN = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{24,}={0,2}/g
/** A run this long that looks random counts in findSecret without a label next to it (Drive ids are 44) */
const BARE_RUN_CHARS = 48
/** Words that make a long run next to them a secret in findSecret ("the passphrase is …") */
const SECRET_LABEL = /password|passwd|passphrase|secret|token|key|credential/i

const isHexToken = (run: string) => hasDigit(run) && /[a-f]/i.test(run)

/**
 * Whether a run looks random: digits, upper and lower case, and the kind of character (upper, lower,
 * digit) changing often, as it does in a random token (about 6 times in 10) and rarely does in words
 * ("LSR-Sponsor-Packet-Fall-2026-v3-FINAL-Draft" is under 2 in 10). Separators split the words.
 */
function isRandomRun(run: string): boolean {
  if (!hasDigit(run) || !/[a-z]/.test(run) || !/[A-Z]/.test(run)) return false
  const kind = (c: string) => (/\d/.test(c) ? 0 : /[a-z]/.test(c) ? 1 : 2)
  let pairs = 0
  let changes = 0
  for (const word of run.split(/[^A-Za-z0-9]+/)) {
    for (let i = 1; i < word.length; i++) {
      pairs++
      if (kind(word[i]) !== kind(word[i - 1])) changes++
    }
  }
  return pairs >= 20 && changes / pairs >= 0.35
}

/** Each secret env var's value in the forms it shows up in text (as is, URL-encoded, JSON-escaped, a link's password) */
function envSecrets(options: RedactOptions): { name: string; value: string }[] {
  const env = options.env ?? process.env
  const found: { name: string; value: string }[] = []
  for (const name of options.envVars ?? SECRET_ENV_VARS) {
    const value = env[name]?.trim()
    if (!value || value.length < MIN_ENV_VALUE_CHARS) continue
    const forms = new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])
    try {
      const password = new URL(value).password
      if (password) {
        forms.add(password)
        forms.add(decodeURIComponent(password))
      }
    } catch {
      // not a link
    }
    for (const form of forms) if (form.length >= MIN_ENV_VALUE_CHARS) found.push({ name, value: form })
  }
  // Longest first, so a value inside another one doesn't leave the rest showing
  return found.sort((a, b) => b.value.length - a.value.length)
}

/** Hex tokens and random-looking runs in text that isn't a link, masked */
function maskRuns(text: string): string {
  return text.replace(HEX_RUN, (run) => (isHexToken(run) ? MASK : run)).replace(RUN, (run) => (isRandomRun(run) ? MASK : run))
}

/**
 * A link without its query string, fragment or password, and with random-looking path segments
 * masked one at a time, so the host and the rest of the path stay readable. The sentence's
 * punctuation after it is kept.
 */
function cleanLink(link: string): string {
  const trailing = LINK_TRAILING.exec(link)?.[0] ?? ""
  const base = link.slice(0, link.length - trailing.length).split(/[?#]/)[0]
  const parts = LINK_PARTS.exec(base)
  if (!parts) return base + trailing
  const [, scheme, authority, path] = parts
  const host = authority.includes("@") ? `${MASK}@${authority.slice(authority.lastIndexOf("@") + 1)}` : authority
  return scheme + host + path.split("/").map(maskRuns).join("/") + trailing
}

/** Applies fn to the text between links, leaving the links as they are */
function betweenLinks(text: string, fn: (part: string) => string): string {
  let out = ""
  let last = 0
  for (const match of text.matchAll(LINK)) {
    out += fn(text.slice(last, match.index)) + match[0]
    last = match.index + match[0].length
  }
  return out + fn(text.slice(last))
}

/** Whether a KEY_RULES match counts as a secret, and the prefix it keeps */
function keyMatch(rule: (typeof KEY_RULES)[number], match: string, first: unknown): { keep: string; counts: boolean } {
  const keep = rule.keeps && typeof first === "string" ? first : ""
  return { keep, counts: !rule.when || rule.when(match.slice(keep.length)) }
}

function maskKeys(text: string): string {
  let out = text
  for (const rule of KEY_RULES) {
    out = out.replace(rule.pattern, (match: string, first: unknown) => {
      const { keep, counts } = keyMatch(rule, match, first)
      return counts ? `${keep}${MASK}` : match
    })
  }
  return out
}

/**
 * Whether an assignment holds a secret. After `=` or a quoted name (JSON), a value of 6 characters or
 * more. After an unquoted "name:", which is often prose ("token: expired"), only one token of 8 or
 * more that mixes letters and digits ("password: lsrRacing2026").
 */
function isSecretAssignment(quote: string, separator: string, value: string): boolean {
  const bare = value.replace(/^["']|["']$/g, "")
  if (separator.includes(":") && !quote) return /^\S{8,}$/.test(bare) && hasDigit(bare) && /[a-z]/i.test(bare)
  return bare.length >= 6
}

function maskAssignments(text: string): string {
  return text.replace(ASSIGNMENT, (match: string, quote: string, name: string, separator: string, value: string) => {
    if (!isSecretAssignment(quote, separator, value)) return match
    const valueQuote = /^["']/.test(value) ? value[0] : ""
    return `${quote}${name}${quote}${separator}${valueQuote}${MASK}${valueQuote}`
  })
}

/**
 * Text that's safe to store or show: secret env values, private keys, link passwords, query strings and
 * fragments, API keys and tokens, secret-named assignments (`CRON_SECRET=…`, `"access_token": "…"`), hex
 * tokens and random-looking runs are masked, and the result is cut to maxLength.
 */
export function redactSecrets(text: string, options: RedactOptions = {}): string {
  const maxLength = Math.max(0, options.maxLength ?? REDACT_MAX_CHARS)
  let out = text
  // Redact a margin past the cut first, so a secret straddling the cut can't leave half of itself.
  // Text past the margin is dropped back to the last whitespace, so no partial token is left either
  const cap = maxLength + REDACT_MARGIN_CHARS
  if (out.length > cap) {
    const head = out.slice(0, cap)
    const lastSpace = head.search(/\s\S*$/)
    out = lastSpace > 0 ? head.slice(0, lastSpace) : head
  }
  for (const { name, value } of envSecrets(options)) out = out.split(value).join(`[redacted ${name}]`)
  out = out.replace(PEM, MASK)
  out = out.replace(LINK, cleanLink)
  out = maskKeys(out)
  out = maskAssignments(out)
  out = betweenLinks(out, maskRuns)
  if (out.length <= maxLength) return out
  return maxLength === 0 ? "" : `${out.slice(0, maxLength - 1)}…`
}

/** What kind of secret the text seems to hold ("a Stripe key", "the value of CRON_SECRET"), or null */
export function findSecret(text: string, options: Pick<RedactOptions, "envVars" | "env"> = {}): string | null {
  if (text.length > FIND_SECRET_MAX_CHARS) return "text too long to check for secrets"
  for (const { name, value } of envSecrets(options)) if (text.includes(value)) return `the value of ${name}`
  if (text.search(PEM) !== -1) return "a private key"

  // In a link, a password counts, and so does any long token in its query string or fragment. A long
  // id in its path (a Google Doc's, say) doesn't on its own; webhook links are KEY_RULES
  const queries: string[] = []
  for (const [link] of text.matchAll(LINK)) {
    if (LINK_PASSWORD.test(link)) return "a password in a link"
    const query = link.search(/[?#]/)
    if (query !== -1) queries.push(link.slice(query))
  }
  for (const query of queries) {
    for (const [run] of query.matchAll(HEX_RUN)) if (isHexToken(run)) return "a token in a link"
    for (const [run] of query.matchAll(RUN)) if (isRandomRun(run)) return "a token in a link"
  }

  for (const rule of KEY_RULES) {
    for (const match of text.matchAll(rule.pattern)) if (keyMatch(rule, match[0], match[1]).counts) return rule.kind
  }
  for (const [, quote, , separator, value] of text.matchAll(ASSIGNMENT)) if (isSecretAssignment(quote, separator, value)) return "a password or token"

  // Outside links: hex tokens, and random-looking runs that are long or come right after a secret-ish
  // word on the same line ("the backup passphrase is …"). A bare Drive or Docs id passes.
  const unlinked = text.replace(LINK, " ")
  for (const [run] of unlinked.matchAll(HEX_RUN)) if (isHexToken(run)) return "a long random-looking string"
  for (const match of unlinked.matchAll(RUN)) {
    if (!isRandomRun(match[0])) continue
    const before = unlinked.slice(Math.max(0, match.index - 40), match.index).split(/[\n\r]/).pop() ?? ""
    if (match[0].length >= BARE_RUN_CHARS || SECRET_LABEL.test(before)) return "a long random-looking string"
  }
  return null
}

/** Whether the text seems to hold a secret (the knowledge tool's save check) */
export function looksLikeSecret(text: string, options: Pick<RedactOptions, "envVars" | "env"> = {}): boolean {
  return findSecret(text, options) !== null
}
