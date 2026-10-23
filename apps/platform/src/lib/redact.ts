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
  "JACK_DATABASE_URL",
  "DATABASE_URL",
  "DIRECT_URL",
] as const

/** The longest text redactSecrets returns by default */
export const REDACT_MAX_CHARS = 2_000

export type RedactOptions = {
  /** Env vars whose values are masked (default SECRET_ENV_VARS) */
  envVars?: readonly string[]
  /** Where their values come from (default process.env) */
  env?: Record<string, string | undefined>
  /** The longest result, in characters (default REDACT_MAX_CHARS) */
  maxLength?: number
}

const MASK = "[redacted]"
/** Shorter env values aren't masked: a local placeholder like "dev" would mask every "dev" */
const MIN_ENV_VALUE_CHARS = 8
/** Text past the result's length that's still redacted before the cut, so no secret is cut in half first */
const REDACT_MARGIN_CHARS = 10_000

/**
 * Links with a scheme (https://, postgresql://, …), up to whitespace, a quote or an angle bracket. The
 * scheme starts only where a run of scheme characters starts, so a long "a.b.c…" can't take seconds
 */
const LINK = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi
/** Punctuation after a link that belongs to the sentence, not the link */
const LINK_TRAILING = /[)\].,;:!?]+$/
/** The user:password@ part of a link */
const LINK_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i
/** A link with a password in it (user:password@host) */
const LINK_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/?#@:]*:[^/?#@]+@/i

const PEM = /-----BEGIN [A-Z0-9 ]*-----[\s\S]*?(?:-----END [A-Z0-9 ]*-----|$)/g

/**
 * Keys and tokens by shape. With `keeps`, the pattern's first group is left in place (the "Bearer "
 * before a token) and only the rest is masked. `when` decides on the masked part, for shapes that
 * ordinary words can take
 */
const KEY_RULES: { kind: string; pattern: RegExp; keeps?: true; when?: (secret: string) => boolean }[] = [
  { kind: "a Stripe key", pattern: /\b(?:sk|rk)_[A-Za-z0-9_]{12,}/g },
  { kind: "a webhook signing secret", pattern: /\bwhsec_[A-Za-z0-9+/=_-]{8,}/g },
  { kind: "an API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { kind: "a Resend key", pattern: /\bre_[A-Za-z0-9_]{16,}/g },
  { kind: "a Vercel token", pattern: /\bvc[a-z]_[A-Za-z0-9_-]{16,}/g },
  { kind: "a Discord webhook link", pattern: /(\bdiscord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/)[A-Za-z0-9_-]{20,}/gi, keeps: true },
  { kind: "a bot token", pattern: /(\bBot\s+)[A-Za-z0-9._-]{20,}/g, keeps: true },
  // "Bearer authentication" is prose: a token has a digit or is long
  { kind: "a bearer token", pattern: /(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{8,}/gi, keeps: true, when: (token) => /\d/.test(token) || token.length >= 20 },
  { kind: "a JWT", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g },
  // Discord's bot token shape (three dot-separated parts), with or without "Bot ". It starts only where
  // a run starts (not at each hyphen inside one), which keeps a long hyphenated run from taking seconds
  { kind: "a token", pattern: /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{27,}/g },
]

/** Names that hold a secret, in `NAME=value` or a quoted `"name": "value"` */
const SECRET_NAME = String.raw`[A-Za-z0-9_-]*(?:password|passwd|passphrase|secret|token|api[_-]?key|private[_-]?key)`
const ASSIGNMENT = new RegExp(String.raw`(["']?)(?<![A-Za-z0-9_-])(${SECRET_NAME})\1(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s"',;&}]+)`, "gi")

/** Long random-looking runs: hex (hashes, key ids), and base64 with upper and lower case and digits */
const HEX_RUN = /\b[0-9a-fA-F]{40,}\b/g
const BASE64_RUN = /[A-Za-z0-9+/_-]{40,}={0,2}/g
const isHexSecret = (run: string) => /\d/.test(run) && /[a-f]/i.test(run)
const isBase64Secret = (run: string) => /\d/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run)

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

/** A link without its query string, fragment or password, keeping the sentence's punctuation after it */
function cleanUrl(link: string): string {
  const trailing = LINK_TRAILING.exec(link)?.[0] ?? ""
  const core = link.slice(0, link.length - trailing.length)
  return core.split(/[?#]/)[0].replace(LINK_USERINFO, `$1${MASK}@`) + trailing
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
 * Whether an assignment holds a secret: after `=`, or after a colon only when the name is quoted
 * (JSON), since "token: expired" is prose; and the value is long enough to be one
 */
function isSecretAssignment(quote: string, separator: string, value: string): boolean {
  if (separator.includes(":") && !quote) return false
  return value.replace(/^["']|["']$/g, "").length >= 6
}

function maskAssignments(text: string): string {
  return text.replace(ASSIGNMENT, (match: string, quote: string, name: string, separator: string, value: string) => {
    if (!isSecretAssignment(quote, separator, value)) return match
    const valueQuote = /^["']/.test(value) ? value[0] : ""
    return `${quote}${name}${quote}${separator}${valueQuote}${MASK}${valueQuote}`
  })
}

function maskRuns(text: string): string {
  return text.replace(HEX_RUN, (run) => (isHexSecret(run) ? MASK : run)).replace(BASE64_RUN, (run) => (isBase64Secret(run) ? MASK : run))
}

/**
 * Text that's safe to store or show: secret env values, private keys, link passwords, query strings and
 * fragments, API keys and tokens, secret-named assignments (`CRON_SECRET=…`, `"access_token": "…"`) and
 * long random-looking runs are masked, and the result is cut to maxLength.
 */
export function redactSecrets(text: string, options: RedactOptions = {}): string {
  const maxLength = options.maxLength ?? REDACT_MAX_CHARS
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
  out = out.replace(LINK, cleanUrl)
  out = maskKeys(out)
  out = maskAssignments(out)
  out = maskRuns(out)
  return out.length > maxLength ? `${out.slice(0, Math.max(0, maxLength - 1))}…` : out
}

/** What kind of secret the text seems to hold ("a Stripe key", "the value of CRON_SECRET"), or null */
export function findSecret(text: string, options: Pick<RedactOptions, "envVars" | "env"> = {}): string | null {
  for (const { name, value } of envSecrets(options)) if (text.includes(value)) return `the value of ${name}`
  if (text.search(PEM) !== -1) return "a private key"

  // In a link, a password counts, and so does a long token in its query string or fragment; a long id
  // in its path (a Google Doc's, say) doesn't on its own. Webhook links are KEY_RULES
  const parts: string[] = []
  let rest = text
  for (const [link] of text.matchAll(LINK)) {
    if (LINK_PASSWORD.test(link)) return "a password in a link"
    const query = link.search(/[?#]/)
    if (query !== -1) parts.push(link.slice(query))
    rest = rest.replace(link, " ")
  }
  const withoutLinkPaths = [rest, ...parts].join(" ")

  for (const rule of KEY_RULES) {
    for (const match of text.matchAll(rule.pattern)) if (keyMatch(rule, match[0], match[1]).counts) return rule.kind
  }
  for (const [, quote, , separator, value] of text.matchAll(ASSIGNMENT)) if (isSecretAssignment(quote, separator, value)) return "a password or token"
  for (const [run] of withoutLinkPaths.matchAll(HEX_RUN)) if (isHexSecret(run)) return "a long random-looking string"
  for (const [run] of withoutLinkPaths.matchAll(BASE64_RUN)) if (isBase64Secret(run)) return "a long random-looking string"
  return null
}

/** Whether the text seems to hold a secret (the knowledge tool's save check) */
export function looksLikeSecret(text: string, options: Pick<RedactOptions, "envVars" | "env"> = {}): boolean {
  return findSecret(text, options) !== null
}
