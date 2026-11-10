// OTA signatures (docs/ota.md §3.3): ECDSA P-256 with SHA-256, signatures in DER (what Android's
// `SHA256withECDSA` verifies), public keys as base64 SPKI DER (one line, easy to paste into the app).
//
// The signed texts must stay byte-identical here, in the phone's verifier (android/runtime/.../ZnOtaSignature.kt) and
// in the update server (step 4.4). A test checks a signature made here on the JVM.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto"
import { BUNDLE_OSES, type BundleRequires } from "../bundle-info"

export const SIGNATURE_VERSION = "zn-ota-v1"
/** The pointer target that means "run the APK's own bundle" (the kill switch, ota.md §3.1). */
export const BUILT_IN = "BUILT_IN"

export interface Signature {
  /** Which key signed it: the first 16 hex characters of SHA-256 over the public key (for logs and status). */
  keyId: string
  /** base64 DER. */
  value: string
}

/**
 * A bundle's needs as one line, the same in every language: modules sorted by name, then each OS's own modules
 * (Android, then iOS), only when it has some (docs/ota-requires-per-os.md §3), so a bundle without them keeps its line.
 * "registry=8;bytecode=99;hostApi=2;modules=Device:1,Fetch:1;android=AdId:1"
 */
export function requiresLine(r: BundleRequires): string {
  const list = (m: Record<string, number>) =>
    Object.keys(m)
      .sort()
      .map((k) => `${k}:${m[k]}`)
      .join(",")
  let line = `registry=${r.registry};bytecode=${r.bytecode};hostApi=${r.hostApi};modules=${list(r.modules)}`
  for (const os of BUNDLE_OSES) {
    const m = r.os?.[os]
    if (m && Object.keys(m).length > 0) line += `;${os}=${list(m)}`
  }
  return line
}

/** What a bundle's signature covers: the bundle is these exact files, needs this, and is this exact zip. */
export function bundleText(b: {
  app: string
  id: string
  serial: number
  bundleSha256: string
  requires: BundleRequires
  zipSha256: string
  zipSize: number
}): string {
  return [SIGNATURE_VERSION, "bundle", b.app, b.id, String(b.serial), b.bundleSha256, requiresLine(b.requires), b.zipSha256, String(b.zipSize)].join("\n")
}

/** What a pointer's signature covers: this channel of this app chose this bundle (or BUILT_IN) at change number seq. */
export function pointerText(p: { app: string; channel: string; seq: number; target: string }): string {
  return [SIGNATURE_VERSION, "pointer", p.app, p.channel, String(p.seq), p.target].join("\n")
}

export function keyId(publicKeyBase64: string): string {
  return createHash("sha256").update(Buffer.from(publicKeyBase64, "base64")).digest("hex").slice(0, 16)
}

/** A new key pair: the private key as PEM (keep it secret, outside the repo), the public key as base64 SPKI DER. */
export function generateKeys(): { privatePem: string; publicBase64: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  }
}

/** The public key (base64 SPKI DER) of a private key PEM. */
export function publicKeyOf(privatePem: string): string {
  return createPublicKey(createPrivateKey(privatePem)).export({ type: "spki", format: "der" }).toString("base64")
}

export function signText(text: string, privatePem: string): Signature {
  const key = createPrivateKey(privatePem)
  const value = sign("sha256", Buffer.from(text, "utf8"), key).toString("base64")
  return { keyId: keyId(publicKeyOf(privatePem)), value }
}

/** True if [signature] signs [text] with any of [publicKeys] (base64 SPKI DER): the app trusts a main and a backup key. */
export function verifyText(text: string, signature: Signature, publicKeys: string[]): boolean {
  const der = Buffer.from(signature.value, "base64")
  return publicKeys.some((pk) => {
    try {
      const key = createPublicKey({ key: Buffer.from(pk, "base64"), format: "der", type: "spki" })
      return verify("sha256", Buffer.from(text, "utf8"), key, der)
    } catch {
      return false
    }
  })
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex")
}
