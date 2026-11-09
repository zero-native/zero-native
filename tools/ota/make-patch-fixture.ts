// Writes the fixtures ZnBsPatchTest and ZnOtaInstallPatchTest (Kotlin, JVM) use: an old and a new "bytecode" file and
// the ZNBSDIFF1 patch between them, made here by tools/ota/bsdiff.ts. So the tests prove the phone applies what the
// server makes. The bytes come from a fixed seed: running it again writes the same files.
//   bun run tools/ota/make-patch-fixture.ts
import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { applyPatch, makePatch } from "./bsdiff"

/** A small fixed-seed random number maker (xorshift32), so the fixture never changes by itself. */
let seed = 0x2f6b1d3c
function rand(n: number): number {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return (seed >>> 0) % n
}

/** Bytes that look a bit like Hermes output: words from a small list, numbers and some noise. */
function fakeCode(size: number): Uint8Array {
  const words = ["getProp", "putById", "call", "ret", "loadConst", "jmp", "Toast", "navigate", "price", "₹"].map((w) =>
    new TextEncoder().encode(w),
  )
  const out = new Uint8Array(size)
  let at = 0
  while (at < size) {
    const r = rand(10)
    if (r < 6) {
      const w = words[rand(words.length)]!
      for (let i = 0; i < w.length && at < size; i++) out[at++] = w[i]!
    } else if (r < 9) {
      out[at++] = rand(16)
    } else {
      out[at++] = rand(256)
    }
  }
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const old = fakeCode(12_000)
// The new file: a few changed bytes, a new block, a removed block and a moved block (so the patch has seeks back
// and forward, not just one control).
const changed = old.slice()
for (const at of [100, 2_000, 2_001, 7_777]) changed[at] = (changed[at]! + 1) & 0xff
const nw = concat(
  changed.subarray(0, 3_000),
  fakeCode(400), // new code
  changed.subarray(3_000, 5_000),
  changed.subarray(5_300, 9_000), // 300 bytes removed
  changed.subarray(10_000, 12_000), // moved before the block it used to follow
  changed.subarray(9_000, 10_000),
)
const patch = makePatch(old, nw)
const back = applyPatch(old, patch, nw.length)
if (Buffer.compare(Buffer.from(back), Buffer.from(nw)) !== 0) throw new Error("applyPatch didn't make the new file")
const controls = Number(new DataView(patch.buffer).getBigInt64(16, true))
if (controls < 3) throw new Error(`only ${controls} controls: the fixture should test seeks`)

// A new file made from nothing (an empty old file): all bytes come from the extra part.
const fromEmptyNew = new TextEncoder().encode("a file the old bundle didn't have\n")
const fromEmpty = makePatch(new Uint8Array(0), fromEmptyNew)

const dir = join(import.meta.dir, "../../android/runtime/src/test/resources/ota-patch")
mkdirSync(dir, { recursive: true })
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")
await Bun.write(join(dir, "old.hbc"), old)
await Bun.write(join(dir, "new.hbc"), nw)
await Bun.write(join(dir, "main.patch"), patch)
await Bun.write(join(dir, "from-empty.patch"), fromEmpty)
await Bun.write(
  join(dir, "fixture.json"),
  JSON.stringify(
    {
      note: "Made by tools/ota/make-patch-fixture.ts (tools/ota/bsdiff.ts makePatch) from a fixed seed.",
      old: { size: old.length, sha256: sha(old) },
      new: { size: nw.length, sha256: sha(nw) },
      patch: { size: patch.length, controls },
      fromEmpty: { text: new TextDecoder().decode(fromEmptyNew), size: fromEmpty.length },
    },
    null,
    2,
  ) + "\n",
)
console.log(`wrote ${dir}: patch ${patch.length} bytes, ${controls} controls`)
