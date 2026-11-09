import { describe, expect, test } from "bun:test"
import { applyPatch, makePatch } from "../bsdiff"

/** A small fixed-seed random bytes maker (xorshift32), so a failing case can be run again. */
function random(size: number, seed: number): Uint8Array {
  let s = seed | 0 || 1
  const out = new Uint8Array(size)
  for (let i = 0; i < size; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    out[i] = s & 0xff
  }
  return out
}

const text = (s: string) => new TextEncoder().encode(s)
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.compare(a, b) === 0

/** Bytes with structure, a bit like compiled code: repeated lines with changing numbers. */
function structured(lines: number, change: (i: number) => string = (i) => String(i)): Uint8Array {
  let s = ""
  for (let i = 0; i < lines; i++) s += `function item${i % 37}(a, b) { return a + b * ${change(i)}; } // line ${i}\n`
  return text(s)
}

function roundTrip(old: Uint8Array, nw: Uint8Array): Uint8Array {
  const patch = makePatch(old, nw)
  expect(same(applyPatch(old, patch, nw.length), nw)).toBe(true)
  return patch
}

describe("bsdiff round trip", () => {
  test("random data: a few changed bytes make a small patch", () => {
    const old = random(60_000, 7)
    const nw = old.slice()
    for (const at of [10, 5_000, 5_001, 31_000, 59_999]) nw[at] = (nw[at]! + 1) & 0xff
    const patch = roundTrip(old, nw)
    // The diff part is mostly zeros (the zip deflates it), and nothing is copied: the size is old size + small header.
    expect(patch.length).toBeLessThan(old.length + 1_000)
    const zeros = patch.filter((b) => b === 0).length
    expect(zeros).toBeGreaterThan(old.length * 0.9)
  })

  test("random data: bytes inserted and removed in the middle", () => {
    const old = random(40_000, 11)
    const nw = new Uint8Array([...old.subarray(0, 12_000), ...random(300, 3), ...old.subarray(12_500, 30_000), ...old.subarray(31_000)])
    const patch = roundTrip(old, nw)
    expect(patch.length).toBeLessThan(nw.length + 2_000) // only the 300 new bytes are extra
  })

  test("random data: two unrelated files still round trip", () => {
    roundTrip(random(20_000, 1), random(25_000, 2))
  })

  test("structured data: a change in the middle, a longer file, a shorter file", () => {
    const old = structured(2_000)
    roundTrip(old, structured(2_000, (i) => (i === 1_000 ? "12345" : String(i))))
    roundTrip(old, structured(2_300))
    roundTrip(old, structured(1_500))
    roundTrip(old, structured(2_000, (i) => String(i + 1)))
  })

  test("structured data: the new file is the old one with blocks moved", () => {
    const old = structured(1_000)
    const nw = new Uint8Array([...old.subarray(old.length >> 1), ...old.subarray(0, old.length >> 1)])
    roundTrip(old, nw)
  })

  test("identical files", () => {
    const old = random(10_000, 5)
    const patch = roundTrip(old, old.slice())
    expect(patch.length).toBeLessThan(old.length + 200)
  })

  test("empty old: the patch carries the whole new file", () => {
    const nw = random(5_000, 9)
    const patch = roundTrip(new Uint8Array(0), nw)
    expect(patch.length).toBeGreaterThanOrEqual(nw.length)
  })

  test("empty new: the patch makes an empty file", () => {
    const patch = roundTrip(random(5_000, 9), new Uint8Array(0))
    expect(applyPatch(random(5_000, 9), patch, 0).length).toBe(0)
  })

  test("both empty", () => {
    roundTrip(new Uint8Array(0), new Uint8Array(0))
  })

  test("tiny files", () => {
    roundTrip(text("a"), text("b"))
    roundTrip(text("hello world"), text("hello there world"))
    roundTrip(text(""), text("x"))
  })

  test("the patch starts with the ZNBSDIF1 magic and writes the sizes as 8-byte little endian", () => {
    const old = random(3_000, 2)
    const nw = random(3_100, 3)
    const patch = makePatch(old, nw)
    expect(new TextDecoder().decode(patch.subarray(0, 8))).toBe("ZNBSDIF1")
    const dv = new DataView(patch.buffer, patch.byteOffset, patch.byteLength)
    expect(Number(dv.getBigInt64(8, true))).toBe(3_100)
    const controls = Number(dv.getBigInt64(16, true))
    expect(controls).toBeGreaterThan(0)
    // Every length adds up: header + controls + diff bytes + extra bytes is the whole patch.
    let add = 0
    let copy = 0
    for (let c = 0; c < controls; c++) {
      add += Number(dv.getBigInt64(24 + c * 24, true))
      copy += Number(dv.getBigInt64(32 + c * 24, true))
    }
    expect(24 + controls * 24 + add + copy).toBe(patch.length)
    expect(add + copy).toBe(3_100)
  })
})

describe("applyPatch refuses a bad patch", () => {
  const old = structured(300)
  const nw = structured(300, (i) => (i % 50 === 0 ? "999" : String(i)))
  const good = makePatch(old, nw)

  test("the good patch works (the base of the cases below)", () => {
    expect(same(applyPatch(old, good, nw.length), nw)).toBe(true)
  })

  test("every truncated patch is refused", () => {
    for (let cut = 0; cut < good.length; cut++) {
      let failed = false
      try {
        applyPatch(old, good.subarray(0, cut), nw.length)
      } catch {
        failed = true
      }
      if (!failed) throw new Error(`a patch cut to ${cut} of ${good.length} bytes was accepted`)
    }
  })

  /** A copy of the good patch with one 8-byte number of the header changed. */
  function withNumber(at: number, value: bigint): Uint8Array {
    const p = good.slice()
    new DataView(p.buffer).setBigInt64(at, value, true)
    return p
  }

  test("a wrong magic", () => {
    const p = good.slice()
    p[0] = 0x58
    expect(() => applyPatch(old, p)).toThrow("not a ZNBSDIFF1 patch")
    expect(() => applyPatch(old, new TextEncoder().encode("BSDIFF40 and then some more bytes"))).toThrow()
    expect(() => applyPatch(old, new Uint8Array(0))).toThrow()
  })

  test("a wrong new size: bigger, smaller, negative", () => {
    expect(() => applyPatch(old, withNumber(8, BigInt(nw.length + 1)))).toThrow()
    expect(() => applyPatch(old, withNumber(8, BigInt(nw.length - 1)))).toThrow()
    expect(() => applyPatch(old, withNumber(8, -1n))).toThrow()
    expect(() => applyPatch(old, withNumber(8, 0n))).toThrow()
  })

  test("a wrong number of controls: more, fewer, negative, huge", () => {
    const controls = Number(new DataView(good.buffer).getBigInt64(16, true))
    expect(() => applyPatch(old, withNumber(16, BigInt(controls + 1)))).toThrow()
    expect(() => applyPatch(old, withNumber(16, BigInt(controls - 1)))).toThrow()
    expect(() => applyPatch(old, withNumber(16, -1n))).toThrow()
    expect(() => applyPatch(old, withNumber(16, 1n << 40n))).toThrow()
  })

  test("a control that goes past the new size or the patch, or is negative", () => {
    expect(() => applyPatch(old, withNumber(24, BigInt(nw.length + 5)))).toThrow() // add too long
    expect(() => applyPatch(old, withNumber(32, BigInt(nw.length + 5)))).toThrow() // copy too long
    expect(() => applyPatch(old, withNumber(24, -5n))).toThrow() // negative add
    expect(() => applyPatch(old, withNumber(32, -5n))).toThrow() // negative copy
  })

  test("the expected size is checked", () => {
    expect(() => applyPatch(old, good, nw.length + 1)).toThrow("expected")
  })

  test("a patch of the wrong size is not accepted as another file's patch", () => {
    // Applied to a different old file the bytes come out different; the phone's SHA-256 check catches that. Here: no crash.
    const other = random(old.length, 4)
    const out = applyPatch(other, good, nw.length)
    expect(out.length).toBe(nw.length)
    expect(same(out, nw)).toBe(false)
  })
})
