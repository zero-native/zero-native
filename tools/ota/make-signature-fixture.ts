// Writes the fixture ZnOtaSignatureTest (Kotlin, JVM) verifies: texts signed here with a throwaway key, so the test
// proves the phone builds byte-identical texts and accepts the CLI's signatures. Only the public key and the
// signatures are written; the private key is never saved. Run again only if the signed texts change:
//   bun run tools/ota/make-signature-fixture.ts
import { join } from "node:path"
import { bundleText, generateKeys, pointerText, requiresLine, signText } from "./signing"

const main = generateKeys()
const other = generateKeys() // a key the app doesn't trust
const requires = { registry: 8, bytecode: 99, hostApi: 2, modules: { Toast: 1, Device: 2, Fetch: 1 } }
const bundle = { app: "sample", id: "sample_12", serial: 12, bundleSha256: "ab".repeat(32), requires, zipSha256: "cd".repeat(32), zipSize: 118034 }
const pointer = { app: "sample", channel: "production", seq: 7, target: "sample_12" }
const kill = { app: "sample", channel: "production", seq: 8, target: "BUILT_IN" }

const fixture = {
  note: "Made by tools/ota/make-signature-fixture.ts with a throwaway key; no private key is stored.",
  publicKey: main.publicBase64,
  otherPublicKey: other.publicBase64,
  requiresLine: requiresLine(requires),
  bundle: { ...bundle, text: bundleText(bundle), signature: signText(bundleText(bundle), main.privatePem).value },
  pointer: { ...pointer, text: pointerText(pointer), signature: signText(pointerText(pointer), main.privatePem).value },
  kill: { ...kill, text: pointerText(kill), signature: signText(pointerText(kill), main.privatePem).value },
}
const out = join(import.meta.dir, "../../android/runtime/src/test/resources/ota-signature-fixture.json")
await Bun.write(out, JSON.stringify(fixture, null, 2) + "\n")
console.log(`wrote ${out}`)
