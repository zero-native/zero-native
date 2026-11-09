// Signing in the browser (docs/zn-updates-server.md §1, §6). The owner loads the private key file once per browser
// session. The key lives in memory only: it is never saved and never sent anywhere. The signature format is the same
// as tools/ota/signing.ts: ECDSA P-256 + SHA-256, the value is base64 of the DER form (WebCrypto gives raw r||s).
// No imports from node here: this file runs in the browser (and in `bun test`).

export const SIGNATURE_VERSION = "zn-ota-v1"
export const BUILT_IN = "BUILT_IN"
export const RECORD_FORMAT = 1
export type Priority = "normal" | "high" | "critical"

export interface Signature {
  keyId: string
  value: string
}

export interface SigningKey {
  key: CryptoKey
  /** base64 SPKI DER, as in the app's publicKeys. */
  publicKey: string
  /** First 16 hex characters of SHA-256 over the SPKI DER bytes. */
  keyId: string
}

export interface PointerOut {
  format: number
  app: string
  channel: string
  seq: number
  target: string
  rollout: number
  priority: Priority
  at: string
  reason?: string
  signature: Signature
}

export function toBase64(bytes: Uint8Array): string {
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text.replace(/\s+/g, ""))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/** The key id of a public key (base64 SPKI DER): the first 16 hex characters of its SHA-256. */
export async function keyIdOfPublic(publicKeyBase64: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", fromBase64(publicKeyBase64))
  return hex(new Uint8Array(digest)).slice(0, 16)
}

/** The bytes inside a PKCS#8 PEM file. Says clearly when the file is another kind of key. */
export function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  if (/BEGIN EC PRIVATE KEY/.test(pem)) {
    throw new Error("this is an old-style EC key (BEGIN EC PRIVATE KEY). Use the PKCS#8 file that `bun run ota keygen` made (BEGIN PRIVATE KEY).")
  }
  const m = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/.exec(pem)
  if (!m) throw new Error("this file is not a private key. It must start with -----BEGIN PRIVATE KEY-----")
  return fromBase64(m[1]!)
}

/** Loads the owner's private key (PKCS#8 PEM). Works out its public key and key id. */
export async function loadSigningKey(pem: string): Promise<SigningKey> {
  const der = pemToDer(pem)
  let key: CryptoKey
  try {
    key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])
  } catch {
    throw new Error("the browser could not read this key. It must be an ECDSA P-256 key in PKCS#8 form.")
  }
  const jwk = await crypto.subtle.exportKey("jwk", key)
  // Keep only the public part (drop d), import it, and export it as SPKI.
  const publicJwk: JsonWebKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true }
  const pub = await crypto.subtle.importKey("jwk", publicJwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"])
  const publicKey = toBase64(new Uint8Array(await crypto.subtle.exportKey("spki", pub)))
  return { key, publicKey, keyId: await keyIdOfPublic(publicKey) }
}

function derInteger(x: Uint8Array): number[] {
  let i = 0
  while (i < x.length - 1 && x[i] === 0) i++ // strip leading zeros
  const v = [...x.slice(i)]
  if (v[0]! & 0x80) v.unshift(0) // keep it positive
  return [0x02, v.length, ...v]
}

/** WebCrypto's raw signature (r then s, 32 bytes each) as ASN.1 DER, which is what the server and phones verify. */
export function rawToDer(raw: Uint8Array): Uint8Array {
  if (raw.length !== 64) throw new Error(`unexpected signature length ${raw.length} (expected 64)`)
  const body = [...derInteger(raw.slice(0, 32)), ...derInteger(raw.slice(32))]
  return new Uint8Array([0x30, body.length, ...body])
}

export async function signText(k: SigningKey, text: string): Promise<Signature> {
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k.key, new TextEncoder().encode(text)))
  return { keyId: k.keyId, value: toBase64(rawToDer(raw)) }
}

/** The text a pointer's signature covers (same as pointerText in tools/ota/signing.ts). */
export function pointerText(p: { app: string; channel: string; seq: number; target: string }): string {
  return [SIGNATURE_VERSION, "pointer", p.app, p.channel, String(p.seq), p.target].join("\n")
}

export interface ChangeInput {
  app: string
  channel: string
  seq: number
  /** The text from GET .../next. The server wrote it: we sign exactly this. */
  text: string
  target: string
  rollout: number
  priority: Priority
  reason?: string
  now?: () => Date
}

/** Builds and signs a pointer exactly like changeChannel() in tools/updates/client.ts. We sign the text we build
 *  ourselves; the server's text must match it, or we refuse (the server is not trusted to choose what we sign). */
export async function buildPointer(k: SigningKey, o: ChangeInput): Promise<PointerOut> {
  const text = pointerText({ app: o.app, channel: o.channel, seq: o.seq, target: o.target })
  if (!Number.isInteger(o.seq) || o.seq < 1 || o.text !== text) throw new Error("the server's next pointer doesn't match what you asked for. Nothing was signed.")
  return {
    format: RECORD_FORMAT,
    app: o.app,
    channel: o.channel,
    seq: o.seq,
    target: o.target,
    rollout: o.rollout,
    priority: o.priority,
    at: (o.now ?? (() => new Date()))().toISOString(),
    ...(o.reason ? { reason: o.reason } : {}),
    signature: await signText(k, text),
  }
}
