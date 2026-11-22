// Makes the zip the iOS OTA tests unzip (ios/tests/ota/main.swift): a bundle folder zipped exactly as the release CLI
// zips one (tools/ota/core.ts zipFolder: fflate, sorted names, deflate level 9), with its zn-bundle.json and the
// manifest fields the install checks. tools/ios-unit-test.ts runs it into a scratch folder before the suite:
//   bun run ios/tests/ota/setup.ts <out dir>
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildPatchZip, readBundleZip } from "../../../server/src/patches"
import { bundleSha256 } from "../../../tools/bundle-info"
import { applyPatch, makePatch } from "../../../tools/ota/bsdiff"
import { zipFolder } from "../../../tools/ota/core"
import { sha256Hex } from "../../../tools/ota/signing"
import { zipBundleFiles } from "../../../tools/updates/client"

const out = process.argv[2]
if (!out) throw new Error("usage: setup.ts <out dir>")
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

// ---- Patches (ZnBsPatch.swift, ZnOtaInstall.buildFromPatch) -----------------------------------------------------------
// 1. bsdiff cross-checks: old and new files of many shapes and their patches made by tools/ota/bsdiff.ts makePatch (the
//    server's code), each checked here with its applyPatch; the Swift test must make the same bytes.
// 2. The server contract: a patch zip made by server/src/patches.ts buildPatchZip from two bundle folders (as
//    tools/ota/make-patch-contract.ts does for Android's ZnOtaPatchContractTest), with the new bundle's manifest.
let seed = 0x5eed1234
function rand(n: number): number {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return (seed >>> 0) % n
}
/** Bytes a bit like Hermes output: repeated words, small numbers and some noise. */
function fakeCode(size: number): Uint8Array {
  const words = ["getById", "putById", "call", "ret", "loadConst", "jmp", "navigate", "price", "₹", "Toast"].map((w) => new TextEncoder().encode(w))
  const b = new Uint8Array(size)
  for (let at = 0; at < size; ) {
    const r = rand(10)
    if (r < 6) {
      for (const ch of words[rand(words.length)]!) if (at < size) b[at++] = ch
    } else b[at++] = r < 9 ? rand(16) : rand(256)
  }
  return b
}
function cat(...parts: Uint8Array[]): Uint8Array {
  const o = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    o.set(p, at)
    at += p.length
  }
  return o
}
/** A changed copy: some bytes changed, blocks added, removed and moved. */
function edit(old: Uint8Array, edits: number): Uint8Array {
  let b = old.slice()
  for (let e = 0; e < edits; e++) {
    const at = b.length ? rand(b.length) : 0
    const kind = rand(4)
    if (kind === 0 && b.length) b[at] = (b[at]! + 1 + rand(254)) & 0xff
    else if (kind === 1) b = cat(b.subarray(0, at), fakeCode(1 + rand(300)), b.subarray(at))
    else if (kind === 2) b = cat(b.subarray(0, at), b.subarray(Math.min(b.length, at + 1 + rand(300))))
    else if (b.length > 10) {
      const n = Math.min(1 + rand(500), b.length - at)
      const block = b.slice(at, at + n)
      const rest = cat(b.subarray(0, at), b.subarray(at + n))
      const to = rand(rest.length + 1)
      b = cat(rest.subarray(0, to), block, rest.subarray(to))
    }
  }
  return b
}

const patchDir = join(out, "patches")
const sameOld = fakeCode(5_000)
const shapes: [string, Uint8Array, Uint8Array][] = [
  ["same", sameOld, sameOld.slice()],
  ["fromEmpty", new Uint8Array(0), fakeCode(3_000)],
  ["toEmpty", fakeCode(3_000), new Uint8Array(0)],
  ["allNew", fakeCode(8_000), fakeCode(9_000)],
  ["oneByte", new Uint8Array([7]), new Uint8Array([9])],
]
for (let i = 0; i < 24; i++) {
  const old = fakeCode(200 + rand(60_000))
  shapes.push([`edits${i}`, old, edit(old, 1 + rand(i < 12 ? 8 : 60))])
}
// About the size of ZeroBill's main.hbc: also times the Swift side.
const bigOld = fakeCode(1_600_000)
shapes.push(["big", bigOld, edit(bigOld, 40)])
const cases: { name: string; newSize: number; newSha: string }[] = []
for (const [name, old, nw] of shapes) {
  const patch = makePatch(old, nw)
  if (Buffer.compare(Buffer.from(applyPatch(old, patch, nw.length)), Buffer.from(nw)) !== 0) throw new Error(`bsdiff.ts can't apply its own ${name}`)
  mkdirSync(join(patchDir, "cases", name), { recursive: true })
  writeFileSync(join(patchDir, "cases", name, "old"), old)
  writeFileSync(join(patchDir, "cases", name, "new"), nw)
  writeFileSync(join(patchDir, "cases", name, "patch"), patch)
  cases.push({ name, newSize: nw.length, newSha: sha256Hex(nw) })
}
writeFileSync(join(patchDir, "cases.json"), JSON.stringify(cases))

/** A bundle folder with [files] and its zn-bundle.json, as tools/bundle-info.ts writes one. */
function bundleFolder(dir: string, serial: number, files: Record<string, Uint8Array>) {
  const list: Record<string, { size: number; sha256: string }> = {}
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true })
    writeFileSync(join(dir, name), bytes)
    list[name] = { size: bytes.length, sha256: sha256Hex(bytes) }
  }
  const info = { format: 1, app: "sample", serial, id: `sample_${serial}`, sha256: bundleSha256(list), requires, files: list }
  writeFileSync(join(dir, "zn-bundle.json"), JSON.stringify(info, null, 2))
  return info
}
const c = join(patchDir, "contract")
const oldHbc = fakeCode(400_000)
const shared = fakeCode(5_000)
bundleFolder(join(c, "base"), 11, {
  "main.hbc": oldHbc,
  "main.zn.ui": shared,
  "main.zn.ui.json": new TextEncoder().encode('{"screens":["Home"]}'),
  "images/a.png": png,
  "images/gone.png": fakeCode(900),
})
const newInfo = bundleFolder(join(c, "new"), 12, {
  "main.hbc": edit(oldHbc, 30), // bsdiff: 32 KB or more, and a base file of that name
  "main.zn.ui": shared, // copy: the same bytes
  "main.zn.ui.json": new TextEncoder().encode('{"screens":["Home","Pay"]}'), // zip: small
  "images/moved.png": png, // copy from another name (same SHA)
  "images/new.png": fakeCode(2_000), // zip: new
})
const fullZip = zipBundleFiles(join(c, "new"))
const built = await buildPatchZip(readBundleZip(fullZip), readBundleZip(zipBundleFiles(join(c, "base"))))
if (built.counts.patch < 1 || built.counts.copy < 2 || built.counts.zip < 2) throw new Error(`contract patch zip: ${JSON.stringify(built.counts)}`)
writeFileSync(join(c, "patch.zip"), built.zip)
writeFileSync(
  join(c, "manifest.json"),
  JSON.stringify({
    app: "sample", id: newInfo.id, serial: 12, bundleSha256: newInfo.sha256, requires,
    zip: { sha256: sha256Hex(fullZip), size: fullZip.length }, signature: { value: "" },
  }),
)
writeFileSync(join(c, "files.json"), JSON.stringify(built.files))
console.log(`patch fixtures in ${patchDir}: ${cases.length} bsdiff cases, contract zip ${built.zip.length} bytes ${JSON.stringify(built.counts)}`)
