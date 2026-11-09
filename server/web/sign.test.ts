// Proves the browser signer's output verifies with the same code the server uses (tools/ota/signing.ts verifyText).
import { describe, expect, test } from "bun:test"
import { generateKeys, keyId, pointerText as nodePointerText, publicKeyOf, verifyText } from "../../tools/ota/signing"
import { BUILT_IN, buildPointer, loadSigningKey, pemToDer, pointerText, rawToDer, signText } from "./sign"

describe("browser signer", () => {
  test("loads a PKCS#8 PEM: same public key and key id as the CLI", async () => {
    const k = generateKeys()
    const loaded = await loadSigningKey(k.privatePem)
    expect(loaded.publicKey).toBe(k.publicBase64)
    expect(loaded.publicKey).toBe(publicKeyOf(k.privatePem))
    expect(loaded.keyId).toBe(keyId(k.publicBase64))
  })

  test("signatures (DER) verify with the server's verifier, many times", async () => {
    const k = generateKeys()
    const loaded = await loadSigningKey(k.privatePem)
    for (let i = 0; i < 300; i++) {
      const text = nodePointerText({ app: "demo", channel: "production", seq: i + 1, target: `demo_${i}` })
      const sig = await signText(loaded, text)
      expect(sig.keyId).toBe(loaded.keyId)
      expect(verifyText(text, sig, [k.publicBase64])).toBe(true)
      expect(verifyText(text + "x", sig, [k.publicBase64])).toBe(false)
    }
  })

  test("a signature from another key does not verify", async () => {
    const a = generateKeys()
    const b = generateKeys()
    const text = pointerText({ app: "demo", channel: "staging", seq: 1, target: BUILT_IN })
    const sig = await signText(await loadSigningKey(a.privatePem), text)
    expect(verifyText(text, sig, [b.publicBase64])).toBe(false)
    expect(verifyText(text, sig, [b.publicBase64, a.publicBase64])).toBe(true)
  })

  test("the pointer text is the same as the server's", () => {
    const p = { app: "demo", channel: "staging", seq: 7, target: "demo_3" }
    expect(pointerText(p)).toBe(nodePointerText(p))
  })

  test("rawToDer: high bit gets a 0x00, leading zeros are stripped", () => {
    const raw = new Uint8Array(64)
    raw[0] = 0x80 // r starts with a high bit
    raw[31] = 1
    raw[32] = 0 // s has leading zeros
    raw[33] = 0
    raw[63] = 5
    const der = rawToDer(raw)
    expect([...der.slice(0, 4)]).toEqual([0x30, der.length - 2, 0x02, 33])
    expect(der[4]).toBe(0)
    expect(der[5]).toBe(0x80)
    const sAt = 4 + 33
    expect(der[sAt]).toBe(0x02)
    expect(der[sAt + 1]).toBe(1) // s = 5, one byte
    expect(der[sAt + 2]).toBe(5)
    expect(() => rawToDer(new Uint8Array(10))).toThrow()
  })

  test("buildPointer: same shape as changeChannel, signature verifies", async () => {
    const k = generateKeys()
    const loaded = await loadSigningKey(k.privatePem)
    const text = nodePointerText({ app: "demo", channel: "production", seq: 3, target: "demo_2" })
    const p = await buildPointer(loaded, { app: "demo", channel: "production", seq: 3, text, target: "demo_2", rollout: 5, priority: "normal", reason: "slow start", now: () => new Date("2026-11-09T10:00:00Z") })
    expect(p).toMatchObject({ format: 1, app: "demo", channel: "production", seq: 3, target: "demo_2", rollout: 5, priority: "normal", at: "2026-11-09T10:00:00.000Z", reason: "slow start" })
    expect(verifyText(nodePointerText(p), p.signature, [k.publicBase64])).toBe(true)
    const killText = nodePointerText({ app: "demo", channel: "staging", seq: 1, target: BUILT_IN })
    const noReason = await buildPointer(loaded, { app: "demo", channel: "staging", seq: 1, text: killText, target: BUILT_IN, rollout: 100, priority: "high" })
    expect("reason" in noReason).toBe(false)
  })

  test("buildPointer refuses when the server's text is not what we asked for", async () => {
    const loaded = await loadSigningKey(generateKeys().privatePem)
    const other = nodePointerText({ app: "demo", channel: "production", seq: 3, target: "demo_9" })
    await expect(buildPointer(loaded, { app: "demo", channel: "production", seq: 3, text: other, target: "demo_2", rollout: 5, priority: "normal" })).rejects.toThrow(/Nothing was signed/)
  })

  test("clear errors for wrong key files", () => {
    expect(() => pemToDer("hello")).toThrow(/not a private key/)
    expect(() => pemToDer("-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----")).toThrow(/PKCS#8/)
  })
})
