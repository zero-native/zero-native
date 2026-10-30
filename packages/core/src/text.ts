// TextEncoder / TextDecoder (UTF-8 only, the web shape) for Hermes. The work is done in C++ (core/src/utf8.cpp,
// hermes_engine.cpp), so big bodies decode fast. Installed only when the engine has none.
// Also the UTF-8 helpers fetch's Response uses.

/** Bytes of any web "BufferSource" as (buffer, offset, length), without copying. */
export function byteRange(input: ArrayBuffer | ArrayBufferView): [ArrayBuffer, number, number] {
  if (input instanceof ArrayBuffer) return [input, 0, input.byteLength]
  if (ArrayBuffer.isView(input)) return [input.buffer as ArrayBuffer, input.byteOffset, input.byteLength]
  throw new TypeError("expected an ArrayBuffer or a typed array")
}

/**
 * UTF-8 bytes → string, the web way: a BOM at the start is dropped (unless `keepBom`), bad bytes become U+FFFD,
 * or, with `fatal`, throw a TypeError.
 */
export function decodeUtf8(bytes: Uint8Array, fatal = false, keepBom = false): string {
  let offset = bytes.byteOffset
  let length = bytes.byteLength
  if (!keepBom && length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    offset += 3
    length -= 3
  }
  if (length === 0) return ""
  const text = globalThis.__zn_utf8Decode(bytes.buffer as ArrayBuffer, offset, length, fatal)
  if (text === undefined) throw new TypeError("The data is not valid UTF-8")
  return text
}

export function encodeUtf8(text: string): Uint8Array {
  return new Uint8Array(globalThis.__zn_utf8Encode(text))
}

const UTF8_LABELS = new Set(["utf-8", "utf8", "unicode-1-1-utf-8", "unicode11utf8", "unicode20utf8", "x-unicode20utf8"])

class ZnTextEncoder {
  readonly encoding = "utf-8"

  encode(input = ""): Uint8Array {
    return encodeUtf8(String(input))
  }

  encodeInto(source: string, destination: Uint8Array): { read: number; written: number } {
    // Encode whole characters until the next one doesn't fit.
    let read = 0
    let written = 0
    for (const ch of String(source)) {
      const b = encodeUtf8(ch)
      if (written + b.length > destination.length) break
      destination.set(b, written)
      written += b.length
      read += ch.length
    }
    return { read, written }
  }
}

class ZnTextDecoder {
  readonly encoding = "utf-8"
  readonly fatal: boolean
  readonly ignoreBOM: boolean

  constructor(label = "utf-8", options: { fatal?: boolean; ignoreBOM?: boolean } = {}) {
    if (!UTF8_LABELS.has(String(label).trim().toLowerCase())) {
      throw new RangeError(`TextDecoder: only UTF-8 is supported, not "${label}"`)
    }
    this.fatal = options.fatal === true
    this.ignoreBOM = options.ignoreBOM === true
  }

  decode(input?: ArrayBuffer | ArrayBufferView, options?: { stream?: boolean }): string {
    if (options?.stream) throw new TypeError("TextDecoder: { stream: true } is not supported")
    if (input === undefined) return ""
    const [buffer, offset, length] = byteRange(input)
    return decodeUtf8(new Uint8Array(buffer, offset, length), this.fatal, this.ignoreBOM)
  }
}

export function installText(): void {
  const g = globalThis as any
  if (typeof g.TextEncoder === "undefined") g.TextEncoder = ZnTextEncoder
  if (typeof g.TextDecoder === "undefined") g.TextDecoder = ZnTextDecoder
}
