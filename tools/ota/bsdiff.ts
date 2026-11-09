// bsdiff: a small binary patch from an old file to a new one (Colin Percival's algorithm, bsdiff 4.3), for OTA patches
// (docs/ota-patches.md). Pure TypeScript, no native code: the server makes patches with it, tests check them with
// [applyPatch]. The phone side is android/runtime/.../ZnBsPatch.kt (same format).
//
// Format "ZNBSDIFF1" (not the classic BSDIFF40: that one needs bzip2 on the phone). All numbers are 8-byte little endian.
//   0  "ZNBSDIF1"                  magic, 8 bytes
//   8  newSize                     size of the file the patch makes
//   16 controls                    number of control triples
//   24 controls × (add, copy, seek)  signed: add bytes of (old + diff), copy bytes of extra, then move the old position
//   .. diff bytes (sum of add), then extra bytes (sum of copy)
// The file is stored deflated in the patch zip; the diff part is mostly zeros, so it packs well.
// Safety: the phone checks every length against newSize and the old file, and the result's SHA-256 against the signed
// bundle, so a bad patch can fail, never make a wrong file that runs.

const MAGIC = "ZNBSDIF1"

/** The suffix array of [old] (Larsson–Sadakane qsufsort, as in bsdiff.c). I has old.length + 1 entries. */
function suffixArray(old: Uint8Array): Int32Array {
  const n = old.length
  const I = new Int32Array(n + 1)
  const V = new Int32Array(n + 1)
  const buckets = new Int32Array(256)
  for (let i = 0; i < n; i++) buckets[old[i]!]!++
  for (let i = 1; i < 256; i++) buckets[i]! += buckets[i - 1]!
  for (let i = 255; i > 0; i--) buckets[i] = buckets[i - 1]!
  buckets[0] = 0
  for (let i = 0; i < n; i++) I[++buckets[old[i]!]!] = i
  I[0] = n
  for (let i = 0; i < n; i++) V[i] = buckets[old[i]!]!
  V[n] = 0
  for (let i = 1; i < 256; i++) if (buckets[i] === buckets[i - 1]! + 1) I[buckets[i]!] = -1
  I[0] = -1
  for (let h = 1; I[0] !== -(n + 1); h += h) {
    let len = 0
    let i = 0
    while (i < n + 1) {
      if (I[i]! < 0) {
        len -= I[i]!
        i -= I[i]!
      } else {
        if (len) I[i - len] = -len
        len = V[I[i]!]! + 1 - i
        split(I, V, i, len, h)
        i += len
        len = 0
      }
    }
    if (len) I[i - len] = -len
  }
  for (let i = 0; i < n + 1; i++) I[V[i]!] = i
  return I
}

/** bsdiff.c's split, with its second (tail) call turned into a loop so deep inputs don't grow the stack as much. */
function split(I: Int32Array, V: Int32Array, start: number, len: number, h: number): void {
  for (;;) {
    if (len < 16) {
      for (let k = start; k < start + len; ) {
        let j = 1
        let x = V[I[k]! + h]!
        for (let i = 1; k + i < start + len; i++) {
          const v = V[I[k + i]! + h]!
          if (v < x) {
            x = v
            j = 0
          }
          if (v === x) {
            const t = I[k + j]!
            I[k + j] = I[k + i]!
            I[k + i] = t
            j++
          }
        }
        for (let i = 0; i < j; i++) V[I[k + i]!] = k + j - 1
        if (j === 1) I[k] = -1
        k += j
      }
      return
    }
    const x = V[I[start + (len >> 1)]! + h]!
    let jj = 0
    let kk = 0
    for (let i = start; i < start + len; i++) {
      const v = V[I[i]! + h]!
      if (v < x) jj++
      if (v === x) kk++
    }
    jj += start
    kk += jj
    let i = start
    let j = 0
    let k = 0
    while (i < jj) {
      const v = V[I[i]! + h]!
      if (v < x) i++
      else if (v === x) {
        const t = I[i]!
        I[i] = I[jj + j]!
        I[jj + j] = t
        j++
      } else {
        const t = I[i]!
        I[i] = I[kk + k]!
        I[kk + k] = t
        k++
      }
    }
    while (jj + j < kk) {
      if (V[I[jj + j]! + h] === x) j++
      else {
        const t = I[jj + j]!
        I[jj + j] = I[kk + k]!
        I[kk + k] = t
        k++
      }
    }
    if (jj > start) split(I, V, start, jj - start, h)
    for (let q = 0; q < kk - jj; q++) V[I[jj + q]!] = kk - 1
    if (jj === kk - 1) I[jj] = -1
    if (start + len > kk) {
      len = start + len - kk
      start = kk
      continue
    }
    return
  }
}

function matchLen(a: Uint8Array, aStart: number, b: Uint8Array, bStart: number): number {
  const max = Math.min(a.length - aStart, b.length - bStart)
  let i = 0
  while (i < max && a[aStart + i] === b[bStart + i]) i++
  return i
}

/** < 0 when old[oldStart..] sorts before new[newStart..] over their common length (memcmp). */
function compare(old: Uint8Array, oldStart: number, nw: Uint8Array, newStart: number): number {
  const max = Math.min(old.length - oldStart, nw.length - newStart)
  for (let i = 0; i < max; i++) {
    const d = old[oldStart + i]! - nw[newStart + i]!
    if (d !== 0) return d
  }
  return 0
}

/** The longest match of new[newStart..] in old, by binary search over the suffix array: [length, position]. */
function search(I: Int32Array, old: Uint8Array, nw: Uint8Array, newStart: number): [number, number] {
  let st = 0
  let en = old.length
  while (en - st >= 2) {
    const x = st + ((en - st) >> 1)
    if (compare(old, I[x]!, nw, newStart) < 0) st = x
    else en = x
  }
  const a = matchLen(old, I[st]!, nw, newStart)
  const b = matchLen(old, I[en]!, nw, newStart)
  return a > b ? [a, I[st]!] : [b, I[en]!]
}

/** Grows as bytes are added (the diff and extra parts). */
class Bytes {
  buf: Uint8Array
  length = 0
  constructor(size: number) {
    this.buf = new Uint8Array(Math.max(size, 1024))
  }
  private room(n: number) {
    if (this.length + n <= this.buf.length) return
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.length + n))
    next.set(this.buf.subarray(0, this.length))
    this.buf = next
  }
  push(b: number) {
    this.room(1)
    this.buf[this.length++] = b
  }
  view() {
    return this.buf.subarray(0, this.length)
  }
}

/** Makes a patch that turns [old] into [nw] (ZNBSDIFF1, not compressed: the zip deflates it). */
export function makePatch(old: Uint8Array, nw: Uint8Array): Uint8Array {
  const I = suffixArray(old)
  const oldSize = old.length
  const newSize = nw.length
  const ctrl: number[] = []
  const diff = new Bytes(newSize >> 1)
  const extra = new Bytes(newSize >> 4)
  let scan = 0
  let len = 0
  let pos = 0
  let lastScan = 0
  let lastPos = 0
  let lastOffset = 0
  while (scan < newSize) {
    let oldScore = 0
    let scsc = (scan += len)
    for (; scan < newSize; scan++) {
      ;[len, pos] = search(I, old, nw, scan)
      for (; scsc < scan + len; scsc++) if (scsc + lastOffset < oldSize && old[scsc + lastOffset] === nw[scsc]) oldScore++
      if ((len === oldScore && len !== 0) || len > oldScore + 8) break
      if (scan + lastOffset < oldSize && old[scan + lastOffset] === nw[scan]) oldScore--
    }
    if (len !== oldScore || scan === newSize) {
      let s = 0
      let sf = 0
      let lenF = 0
      for (let i = 0; lastScan + i < scan && lastPos + i < oldSize; ) {
        if (old[lastPos + i] === nw[lastScan + i]) s++
        i++
        if (s * 2 - i > sf * 2 - lenF) {
          sf = s
          lenF = i
        }
      }
      let lenB = 0
      if (scan < newSize) {
        s = 0
        let sb = 0
        for (let i = 1; scan >= lastScan + i && pos >= i; i++) {
          if (old[pos - i] === nw[scan - i]) s++
          if (s * 2 - i > sb * 2 - lenB) {
            sb = s
            lenB = i
          }
        }
      }
      if (lastScan + lenF > scan - lenB) {
        const overlap = lastScan + lenF - (scan - lenB)
        s = 0
        let ss = 0
        let lenS = 0
        for (let i = 0; i < overlap; i++) {
          if (nw[lastScan + lenF - overlap + i] === old[lastPos + lenF - overlap + i]) s++
          if (nw[scan - lenB + i] === old[pos - lenB + i]) s--
          if (s > ss) {
            ss = s
            lenS = i + 1
          }
        }
        lenF += lenS - overlap
        lenB -= lenS
      }
      for (let i = 0; i < lenF; i++) diff.push((nw[lastScan + i]! - old[lastPos + i]!) & 0xff)
      const copy = scan - lenB - (lastScan + lenF)
      for (let i = 0; i < copy; i++) extra.push(nw[lastScan + lenF + i]!)
      ctrl.push(lenF, copy, pos - lenB - (lastPos + lenF))
      lastScan = scan - lenB
      lastPos = pos - lenB
      lastOffset = pos - scan
    }
  }
  const d = diff.view()
  const e = extra.view()
  const out = new Uint8Array(24 + ctrl.length * 8 + d.length + e.length) // header 24 bytes: the patch ends with the extra bytes
  const dv = new DataView(out.buffer)
  out.set(new TextEncoder().encode(MAGIC), 0)
  dv.setBigInt64(8, BigInt(newSize), true)
  dv.setBigInt64(16, BigInt(ctrl.length / 3), true)
  let at = 24
  for (const c of ctrl) {
    dv.setBigInt64(at, BigInt(c), true)
    at += 8
  }
  out.set(d, at)
  out.set(e, at + d.length)
  return out
}

/**
 * Applies a ZNBSDIFF1 patch to [old]. Checks every length (the same checks as the phone), and that the result is
 * [expectSize] bytes when given. Throws on any problem.
 */
export function applyPatch(old: Uint8Array, patch: Uint8Array, expectSize?: number): Uint8Array {
  if (patch.length < 24 || new TextDecoder().decode(patch.subarray(0, 8)) !== MAGIC) throw new Error("not a ZNBSDIFF1 patch")
  const dv = new DataView(patch.buffer, patch.byteOffset, patch.byteLength)
  const newSize = Number(dv.getBigInt64(8, true))
  const controls = Number(dv.getBigInt64(16, true))
  if (newSize < 0 || (expectSize !== undefined && newSize !== expectSize)) throw new Error(`patch makes ${newSize} bytes, expected ${expectSize}`)
  if (controls < 0 || 24 + controls * 24 > patch.length) throw new Error("bad control count")
  const out = new Uint8Array(newSize)
  let diffAt = 24 + controls * 24
  let addTotal = 0
  for (let c = 0; c < controls; c++) addTotal += Number(dv.getBigInt64(24 + c * 24, true))
  let extraAt = diffAt + addTotal
  if (addTotal < 0 || extraAt > patch.length) throw new Error("bad diff length")
  let newPos = 0
  let oldPos = 0
  for (let c = 0; c < controls; c++) {
    const add = Number(dv.getBigInt64(24 + c * 24, true))
    const copy = Number(dv.getBigInt64(32 + c * 24, true))
    const seek = Number(dv.getBigInt64(40 + c * 24, true))
    if (add < 0 || copy < 0 || newPos + add + copy > newSize) throw new Error("control goes past the new size")
    if (diffAt + add > patch.length || extraAt + copy > patch.length) throw new Error("control goes past the patch")
    for (let i = 0; i < add; i++) {
      const o = oldPos + i
      const base = o >= 0 && o < old.length ? old[o]! : 0
      out[newPos + i] = (patch[diffAt + i]! + base) & 0xff
    }
    diffAt += add
    newPos += add
    oldPos += add
    out.set(patch.subarray(extraAt, extraAt + copy), newPos)
    extraAt += copy
    newPos += copy
    oldPos += seek
  }
  if (newPos !== newSize) throw new Error(`patch made ${newPos} of ${newSize} bytes`)
  return out
}
