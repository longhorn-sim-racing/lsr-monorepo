import { createPrivateKey, createSign, type KeyObject } from "node:crypto"
import { serviceBaseUrl } from "../base-url"
import type { ConnectorEnv } from "../types"

/**
 * Google service-account sign-in (research/google-drive.md §2), without the googleapis package: a JWT
 * signed with node:crypto (RS256) is swapped for an access token at Google's token endpoint. There's no
 * refresh token; a new JWT is signed when the token is about to expire. The private key never leaves
 * this module: errors carry Google's error code, never the key or the assertion.
 */

/** Read-only, and the narrowest scope that can list a shared folder and read its files */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly"

/** The JWT's audience is always Google's real token endpoint, also when the request goes to the fake */
export const GOOGLE_TOKEN_AUDIENCE = "https://oauth2.googleapis.com/token"
export const GOOGLE_OAUTH_URL = "https://oauth2.googleapis.com"
export const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer"

/** The longest a JWT may live (Google's limit) */
export const JWT_LIFETIME_S = 3600
export const TOKEN_TIMEOUT_MS = 20_000
/** A token is replaced this long before it expires */
const REFRESH_MARGIN_MS = 5 * 60_000

export type ServiceAccount = {
  /** The service account's client_email */
  email: string
  /** Its private_key, PEM */
  privateKey: string
  /** Its private_key_id, sent as the JWT's `kid` when set */
  keyId?: string
}

/**
 * The service account from GOOGLE_SERVICE_ACCOUNT_JSON, the JSON key Google gives you (its client_email,
 * private_key and private_key_id); null when it's unset. Throws, without quoting it, when it isn't a
 * service account key
 */
export function serviceAccountFromEnv(env: ConnectorEnv = process.env): ServiceAccount | null {
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim()
  if (!raw) return null
  let key: { type?: unknown; client_email?: unknown; private_key?: unknown; private_key_id?: unknown }
  try {
    key = JSON.parse(raw)
  } catch {
    throw new GoogleAuthError(0, "bad_key_file", "GOOGLE_SERVICE_ACCOUNT_JSON isn't JSON: paste the whole key file Google gave you")
  }
  if ((key.type !== undefined && key.type !== "service_account") || typeof key.client_email !== "string" || typeof key.private_key !== "string") {
    throw new GoogleAuthError(0, "bad_key_file", "GOOGLE_SERVICE_ACCOUNT_JSON isn't a service account key (it needs client_email and private_key)")
  }
  return {
    email: key.client_email.trim(),
    // A key pasted with its line breaks escaped twice keeps a literal "\n"
    privateKey: key.private_key.replace(/\\n/g, "\n"),
    ...(typeof key.private_key_id === "string" && key.private_key_id ? { keyId: key.private_key_id } : {}),
  }
}

export class GoogleAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    description = "",
  ) {
    super(`Google sign-in failed (${status ? `${status} ` : ""}${code}${description ? `: ${description.slice(0, 200)}` : ""})`)
    this.name = "GoogleAuthError"
  }
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url")

function privateKeyOf(pem: string): KeyObject {
  try {
    return createPrivateKey(pem)
  } catch {
    // The parser's own message can quote the input
    throw new GoogleAuthError(0, "bad_private_key", "the service account's private_key isn't a PEM private key")
  }
}

/** A signed JWT asking for `scope`, valid for an hour from `nowMs` */
export function signServiceAccountJwt(account: ServiceAccount, { nowMs = Date.now(), scope = DRIVE_SCOPE }: { nowMs?: number; scope?: string } = {}): string {
  const iat = Math.floor(nowMs / 1000)
  const header = { alg: "RS256", typ: "JWT", ...(account.keyId ? { kid: account.keyId } : {}) }
  const claims = { iss: account.email, scope, aud: GOOGLE_TOKEN_AUDIENCE, iat, exp: iat + JWT_LIFETIME_S }
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKeyOf(account.privateKey))
  return `${unsigned}.${base64url(signature)}`
}

export type GoogleToken = { accessToken: string; expiresAt: number }

/** Swaps a fresh JWT for an access token */
export async function fetchGoogleToken(account: ServiceAccount, { env = process.env, signal, nowMs = Date.now() }: { env?: ConnectorEnv; signal?: AbortSignal; nowMs?: number } = {}): Promise<GoogleToken> {
  const assertion = signServiceAccountJwt(account, { nowMs })
  const timeout = AbortSignal.timeout(TOKEN_TIMEOUT_MS)
  const response = await fetch(`${serviceBaseUrl("google-drive", GOOGLE_OAUTH_URL, env)}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  const body = (await response.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown } | null
  if (!response.ok || typeof body?.access_token !== "string") {
    throw new GoogleAuthError(response.status, typeof body?.error === "string" ? body.error : "no_token", typeof body?.error_description === "string" ? body.error_description : "")
  }
  const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : JWT_LIFETIME_S
  return { accessToken: body.access_token, expiresAt: nowMs + seconds * 1000 }
}

/** An access token kept for one client's life (one job run, one smoke test), replaced 5 minutes before it expires or after a 401 */
export function googleTokenSource(account: ServiceAccount, env: ConnectorEnv = process.env) {
  let current: GoogleToken | null = null
  let pending: Promise<GoogleToken> | null = null
  return {
    async token(signal?: AbortSignal): Promise<string> {
      if (current && current.expiresAt - REFRESH_MARGIN_MS > Date.now()) return current.accessToken
      pending ??= fetchGoogleToken(account, { env, signal }).finally(() => {
        pending = null
      })
      current = await pending
      return current.accessToken
    },
    invalidate() {
      current = null
    },
  }
}
