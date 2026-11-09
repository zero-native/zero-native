// Makes the zip the iOS OTA tests unzip (ios/tests/ota/main.swift): a bundle folder zipped exactly as the release CLI
// zips one (tools/ota/core.ts zipFolder: fflate, sorted names, deflate level 9), with its zn-bundle.json and the
// manifest fields the install checks. Run by tools/ios-ota-test.ts into a scratch folder:
//   bun run ios/tests/ota/make-fixture.ts <out dir>
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { bundleSha256 } from "../../../tools/bundle-info"
import { zipFolder } from "../../../tools/ota/core"
import { sha256Hex } from "../../../tools/ota/signing"

const out = process.argv[2]
if (!out) throw new Error("usage: make-fixture.ts <out dir>")
const dir = join(out, "bundle")
mkdirSync(join(dir, "images"), { recursive: true })

// main.hbc: 300 KB that compresses (several inflate parts); a picture: random bytes (stays about its size).
let code = ""
for (let i = 0; code.length < 300_000; i++) code += `function f${i}(a){return a*${i}+${(i * 7919) % 1000}}\n`
const png = new Uint8Array(70_000)
for (let i = 0; i < png.length; i++) png[i] = (i * 2654435761) >>> 24
const files: Record<string, Uint8Array> = {
  "main.hbc": new TextEncoder().encode(code),
  "main.zn.ui": new TextEncoder().encode("ui"),
  "main.zn.ui.json": new TextEncoder().encode("{}"),
  "images/a.png": png,
}
const listed: Record<string, { size: number; sha256: string }> = {}
for (const [name, bytes] of Object.entries(files)) {
  writeFileSync(join(dir, name), bytes)
  listed[name] = { size: bytes.length, sha256: sha256Hex(bytes) }
}
const requires = { registry: 8, bytecode: 99, hostApi: 2, modules: { Device: 1 } }
const sha = bundleSha256(listed)
const info = { format: 1, app: "sample", serial: 12, id: "sample_12", sha256: sha, requires, files: listed }
writeFileSync(join(dir, "zn-bundle.json"), JSON.stringify(info, null, 2))
const zip = zipFolder(dir)
writeFileSync(join(out, "bundle.zip"), zip)
writeFileSync(
  join(out, "manifest.json"),
  JSON.stringify({
    app: "sample", id: "sample_12", serial: 12, bundleSha256: sha, requires,
    zip: { sha256: sha256Hex(zip), size: zip.length }, signature: { value: "" },
  }),
)
console.log(`fixture in ${out} (zip ${zip.length} bytes)`)
