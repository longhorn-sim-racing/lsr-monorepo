import { generateKeyPairSync, verify } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { mountFakes } from "../fakes/testing"
import { DRIVE_SCOPE, fetchGoogleToken, GOOGLE_TOKEN_AUDIENCE, GoogleAuthError, googleTokenSource, serviceAccountFromEnv, signServiceAccountJwt, type ServiceAccount } from "./auth"
import { DRIVE_FAKE_SA_EMAIL } from "./fake/fixtures"
import { googleDriveFake } from "./fake/handlers"

// A throwaway key, made for this test run only
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } })
const account: ServiceAccount = { email: DRIVE_FAKE_SA_EMAIL, privateKey, keyId: "key-1" }

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("signServiceAccountJwt", () => {
  it("signs Google's claims with RS256, valid for an hour", () => {
    const nowMs = Date.UTC(2026, 9, 22, 18, 0, 0)
    const jwt = signServiceAccountJwt(account, { nowMs })
    const [header, claims, signature] = jwt.split(".")
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT", kid: "key-1" })
    expect(decode(claims)).toEqual({ iss: DRIVE_FAKE_SA_EMAIL, scope: DRIVE_SCOPE, aud: GOOGLE_TOKEN_AUDIENCE, iat: nowMs / 1000, exp: nowMs / 1000 + 3600 })
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, "base64url"))).toBe(true)
  })

  it("leaves out kid without a key id, and never puts a subject (no domain-wide delegation)", () => {
    const [header, claims] = signServiceAccountJwt({ email: "a@b", privateKey }).split(".")
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" })
    expect(decode(claims)).not.toHaveProperty("sub")
  })

  it("refuses a key that isn't a PEM private key, without quoting it", () => {
    const secret = "-----BEGIN PRIVATE KEY-----\nnot-really-a-key\n-----END PRIVATE KEY-----"
    const error = (() => {
      try {
        signServiceAccountJwt({ email: "a@b", privateKey: secret })
      } catch (e) {
        return e as Error
      }
    })()
    expect(error).toBeInstanceOf(GoogleAuthError)
    expect(error!.message).toContain("isn't a PEM private key")
    expect(error!.message).not.toContain("not-really-a-key")
  })
})

describe("serviceAccountFromEnv", () => {
  const keyFile = { type: "service_account", project_id: "lsr-jack", private_key_id: "k1", private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n", client_email: "sa@x.iam.gserviceaccount.com" }

  it("reads the key file Google gives you", () => {
    expect(serviceAccountFromEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(keyFile) })).toEqual({ email: "sa@x.iam.gserviceaccount.com", privateKey: keyFile.private_key, keyId: "k1" })
    expect(serviceAccountFromEnv({})).toBeNull()
  })

  it("turns a key whose line breaks were escaped twice back into a PEM", () => {
    const twice = JSON.stringify(keyFile).replace(/\\n/g, "\\\\n")
    expect(serviceAccountFromEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: twice })?.privateKey).toBe(keyFile.private_key)
  })

  it("refuses something that isn't a service account key, without quoting it", () => {
    expect(() => serviceAccountFromEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: "{not json -----BEGIN" })).toThrow(/isn't JSON/)
    expect(() => serviceAccountFromEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...keyFile, type: "authorized_user" }) })).toThrow(/isn't a service account key/)
    try {
      serviceAccountFromEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: "{not json -----BEGIN" })
    } catch (error) {
      expect((error as Error).message).not.toContain("-----BEGIN")
    }
  })
})

describe("fetchGoogleToken against the fake", () => {
  it("swaps the JWT for a token; the fake checks the signature with the public key", async () => {
    const fakes = mountFakes([googleDriveFake])
    await fetch(`${fakes.origin}/google-drive/_fake/config`, { method: "POST", body: JSON.stringify({ publicKey }) })
    const token = await fetchGoogleToken(account, { nowMs: Date.now() })
    expect(token.accessToken).toMatch(/^ya29\./)
    expect(token.expiresAt).toBeGreaterThan(Date.now() + 3_500_000)
    const request = fakes.requests.find((r) => r.path === "/token")!
    expect(request.headers.get("content-type")).toBe("application/x-www-form-urlencoded")
    expect(new URLSearchParams(request.body).get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer")
  })

  it("fails with Google's error code for a signature from another key or an unknown account", async () => {
    const fakes = mountFakes([googleDriveFake])
    await fetch(`${fakes.origin}/google-drive/_fake/config`, { method: "POST", body: JSON.stringify({ publicKey }) })
    const other = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } })
    await expect(fetchGoogleToken({ ...account, privateKey: other.privateKey })).rejects.toMatchObject({ name: "GoogleAuthError", status: 400, code: "invalid_grant" })
    await expect(fetchGoogleToken({ ...account, email: "someone@else.iam.gserviceaccount.com" })).rejects.toMatchObject({ code: "invalid_grant" })
  })

  it("refuses a JWT whose clock is off (exp already passed)", async () => {
    mountFakes([googleDriveFake])
    await expect(fetchGoogleToken(account, { nowMs: Date.now() - 2 * 3_600_000 })).rejects.toMatchObject({ code: "invalid_grant" })
  })
})

describe("googleTokenSource", () => {
  it("keeps the token until it nearly expires, and signs in again after invalidate()", async () => {
    const fakes = mountFakes([googleDriveFake])
    const source = googleTokenSource(account)
    const first = await source.token()
    expect(await source.token()).toBe(first)
    source.invalidate()
    expect(await source.token()).not.toBe(first)
    expect(fakes.requests.filter((r) => r.path === "/token")).toHaveLength(2)
  })

  it("signs in once when several calls ask at the same time", async () => {
    const fakes = mountFakes([googleDriveFake])
    const source = googleTokenSource(account)
    const tokens = await Promise.all([source.token(), source.token(), source.token()])
    expect(new Set(tokens).size).toBe(1)
    expect(fakes.requests.filter((r) => r.path === "/token")).toHaveLength(1)
  })
})
