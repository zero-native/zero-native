// The web `Headers` class for fetch (docs/fetch.md). Names are case-insensitive; several headers with the same name
// are kept apart (they cross to native as a list of pairs), so `getSetCookie()` returns each `Set-Cookie` on its own.
// Values are checked here, so a bad value is a clear TypeError instead of an OkHttp crash.

export type HeadersInit = Headers | Iterable<readonly [string, string]> | Record<string, string>

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
// HTTP whitespace at either end is removed (web rule).
const EDGE_SPACE = /^[\t\n\r ]+|[\t\n\r ]+$/g

function checkName(name: string): string {
  const n = String(name)
  if (!TOKEN.test(n)) throw new TypeError(`Headers: "${n}" is not a valid header name`)
  return n.toLowerCase()
}

function checkValue(name: string, value: string): string {
  const v = String(value).replace(EDGE_SPACE, "")
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i)
    // OkHttp sends only visible ASCII and tabs. The web allows a few more bytes, but they don't survive the trip.
    if ((c < 0x20 && c !== 0x09) || c > 0x7e) {
      throw new TypeError(
        `Headers: the value of "${name}" has a character that can't be sent (code ${c} at ${i}). ` +
          `Only plain ASCII is allowed; encode other text, e.g. with encodeURIComponent().`,
      )
    }
  }
  return v
}

export class Headers {
  /** [lowercase name, value] in the order they were added. */
  private list: Array<[string, string]> = []

  constructor(init?: HeadersInit | null) {
    if (init == null) return
    if (init instanceof Headers) {
      this.list = init.list.map(([n, v]) => [n, v])
    } else if (typeof (init as any)[Symbol.iterator] === "function") {
      for (const pair of init as Iterable<readonly [string, string]>) {
        if (pair.length !== 2) throw new TypeError("Headers: each entry must be a [name, value] pair")
        this.append(pair[0], pair[1])
      }
    } else if (typeof init === "object") {
      for (const name of Object.keys(init)) this.append(name, (init as Record<string, string>)[name]!)
    } else {
      throw new TypeError("Headers: expected an object, an array of pairs or Headers")
    }
  }

  append(name: string, value: string): void {
    const n = checkName(name)
    this.list.push([n, checkValue(n, value)])
  }

  set(name: string, value: string): void {
    const n = checkName(name)
    const v = checkValue(n, value)
    const at = this.list.findIndex(([k]) => k === n)
    if (at === -1) {
      this.list.push([n, v])
      return
    }
    this.list[at] = [n, v] // keeps the first one's place, drops the others
    this.list = this.list.filter(([k], i) => k !== n || i === at)
  }

  /** All values of `name` joined with ", " (web rule), or null. */
  get(name: string): string | null {
    const n = checkName(name)
    const values = this.list.filter(([k]) => k === n).map(([, v]) => v)
    return values.length === 0 ? null : values.join(", ")
  }

  getSetCookie(): string[] {
    return this.list.filter(([k]) => k === "set-cookie").map(([, v]) => v)
  }

  has(name: string): boolean {
    const n = checkName(name)
    return this.list.some(([k]) => k === n)
  }

  delete(name: string): void {
    const n = checkName(name)
    this.list = this.list.filter(([k]) => k !== n)
  }

  /** Web order: sorted by name, values of one name combined, except `set-cookie` (one entry each). */
  *entries(): IterableIterator<[string, string]> {
    const names = [...new Set(this.list.map(([k]) => k))].sort()
    for (const n of names) {
      if (n === "set-cookie") {
        for (const v of this.getSetCookie()) yield [n, v]
      } else {
        yield [n, this.get(n)!]
      }
    }
  }

  *keys(): IterableIterator<string> {
    for (const [k] of this.entries()) yield k
  }

  *values(): IterableIterator<string> {
    for (const [, v] of this.entries()) yield v
  }

  forEach(fn: (value: string, name: string, headers: Headers) => void): void {
    for (const [k, v] of this.entries()) fn(v, k, this)
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries()
  }

  /** Internal: the raw pairs, flat ([name, value, name, value, ...]), for native. */
  _flat(): string[] {
    return this.list.flat()
  }

  /** Internal: builds Headers from native's flat list (already valid; names keep native's case, lowercased here). */
  static _fromFlat(flat: string[]): Headers {
    const h = new Headers()
    for (let i = 0; i + 1 < flat.length; i += 2) h.list.push([flat[i]!.toLowerCase(), flat[i + 1]!])
    return h
  }
}
