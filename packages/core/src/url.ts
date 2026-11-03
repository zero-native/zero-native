// URL and URLSearchParams (the web shapes) for Hermes, which has neither. Installed only when the engine has none.
// The parser follows the WHATWG URL Standard (https://url.spec.whatwg.org) state by state, so results match browsers
// and Bun for what apps use: http(s)/ws(s)/ftp/file, and app links like upi:, mailto:, tel:, intent:, myapp://host/path.
//
// Not supported, on purpose (small bundle):
// - Non-ASCII host names in special URLs ("https://café.com") need IDNA/punycode tables. They throw a TypeError
//   instead of guessing. Encode the host yourself (xn--...) if you need one. "xn--" labels are passed as they are,
//   not checked.
// - URL.createObjectURL / revokeObjectURL: there is no Blob here.
// - Only UTF-8 (the web default for URLs and forms).

/** The parsed parts. `host` is kept already serialized; `path` is a string for an "opaque" path (mailto:a@b). */
type Rec = {
  scheme: string
  username: string
  password: string
  host: string | null
  port: number | null
  path: string[] | string
  query: string | null
  fragment: string | null
}

// Special schemes and their default ports. No prototype, so "constructor:" is not special.
const SPECIAL: Record<string, number | null> = Object.assign(Object.create(null), {
  ftp: 21, file: null, http: 80, https: 443, ws: 80, wss: 443,
})
const isSpecial = (u: Rec) => u.scheme in SPECIAL

// Percent-encode sets: the ASCII characters encoded on top of controls and non-ASCII (the "C0 control" set).
const C0 = ""
const FRAGMENT = ' "<>`'
const QUERY = ' "#<>'
const SPECIAL_QUERY = QUERY + "'"
const PATH = QUERY + "?^`{}"
const USERINFO = PATH + "/:;=@[\\]|"
const COMPONENT = USERINFO + "$%&+,"
const FORM = COMPONENT + "!'()~"

const HEX: string[] = []
for (let i = 0; i < 256; i++) HEX.push("%" + (i < 16 ? "0" : "") + i.toString(16).toUpperCase())

/** Lone surrogates → U+FFFD, like the web's USVString. */
function toUSV(value: unknown): string {
  const s = String(value)
  if (!/[\ud800-\udfff]/.test(s)) return s
  return s.replace(/[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]/g, (m) => (m.length === 2 ? m : "�"))
}

function utf8(cp: number, out: number[]): void {
  if (cp < 0x80) out.push(cp)
  else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63))
  else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
  else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
}

/** Percent-encodes `s` (a USV string): controls, non-ASCII (as UTF-8 bytes) and the characters in `set`. */
function encode(s: string, set: string, spaceAsPlus = false): string {
  let out = ""
  for (const ch of s) {
    const c = ch.charCodeAt(0)
    if (c >= 0x20 && c < 0x7f && !set.includes(ch)) out += ch
    else if (spaceAsPlus && ch === " ") out += "+"
    else {
      const bytes: number[] = []
      utf8(ch.codePointAt(0)!, bytes)
      for (const b of bytes) out += HEX[b]
    }
  }
  return out
}

const isHex = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)

/** "%41b" → the text, as UTF-8; bad bytes become U+FFFD. */
function decode(s: string): string {
  if (!s.includes("%")) return s
  const b: number[] = []
  for (const ch of s) utf8(ch.codePointAt(0)!, b)
  const bytes: number[] = []
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0x25 && isHex(b[i + 1]!) && isHex(b[i + 2]!)) {
      bytes.push(parseInt(String.fromCharCode(b[i + 1]!, b[i + 2]!), 16))
      i += 2
    } else bytes.push(b[i]!)
  }
  return decodeUtf8Lenient(bytes)
}

/** The web's UTF-8 decoder (no BOM handling): each bad sequence becomes one U+FFFD. */
function decodeUtf8Lenient(b: number[]): string {
  let out = ""
  let need = 0
  let cp = 0
  let lower = 0x80
  let upper = 0xbf
  for (let i = 0; i < b.length; i++) {
    const x = b[i]!
    if (need === 0) {
      if (x < 0x80) out += String.fromCharCode(x)
      else if (x >= 0xc2 && x <= 0xdf) (need = 1), (cp = x & 0x1f)
      else if (x >= 0xe0 && x <= 0xef) {
        if (x === 0xe0) lower = 0xa0
        if (x === 0xed) upper = 0x9f
        ;(need = 2), (cp = x & 0xf)
      } else if (x >= 0xf0 && x <= 0xf4) {
        if (x === 0xf0) lower = 0x90
        if (x === 0xf4) upper = 0x8f
        ;(need = 3), (cp = x & 7)
      } else out += "�"
      continue
    }
    if (x < lower || x > upper) {
      // Bad continuation byte: end the sequence and read this byte again as a start byte.
      ;(need = 0), (lower = 0x80), (upper = 0xbf)
      out += "�"
      i--
      continue
    }
    ;(lower = 0x80), (upper = 0xbf)
    cp = (cp << 6) | (x & 0x3f)
    if (--need === 0) out += String.fromCodePoint(cp)
  }
  return need ? out + "�" : out
}

// ---- hosts ----

/** Thrown inside the parser; the API turns it into a TypeError, setters ignore it (web rule). */
const FAIL = { fail: true }
function fail(): never {
  throw FAIL
}

function parseIPv4Number(s: string): number {
  if (s === "") fail()
  let radix = 10
  if (s.length >= 2 && (s[1] === "x" || s[1] === "X") && s[0] === "0") (s = s.slice(2)), (radix = 16)
  else if (s.length >= 2 && s[0] === "0") (s = s.slice(1)), (radix = 8)
  if (s === "") return 0
  const ok = radix === 10 ? /^[0-9]+$/ : radix === 16 ? /^[0-9a-fA-F]+$/ : /^[0-7]+$/
  if (!ok.test(s)) fail()
  return parseInt(s, radix)
}

/** "Ends in a number": the last label is digits or 0x-hex, so the host must be an IPv4 address. */
function endsInNumber(host: string): boolean {
  const parts = host.split(".")
  if (parts[parts.length - 1] === "" && parts.length > 1) parts.pop()
  const last = parts[parts.length - 1]!
  return /^[0-9]+$/.test(last) || /^0[xX][0-9a-fA-F]*$/.test(last)
}

/** "192.168.0.1", "0x7f.1", "2130706433" → "127.0.0.1" and friends. */
function parseIPv4(host: string): string {
  const parts = host.split(".")
  if (parts[parts.length - 1] === "" && parts.length > 1) parts.pop()
  if (parts.length > 4) fail()
  const nums = parts.map(parseIPv4Number)
  for (let i = 0; i < nums.length - 1; i++) if (nums[i]! > 255) fail()
  if (nums[nums.length - 1]! >= 256 ** (5 - nums.length)) fail()
  let ip = nums[nums.length - 1]!
  for (let i = 0; i < nums.length - 1; i++) ip += nums[i]! * 256 ** (3 - i)
  return [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join(".")
}

const isDigitAt = (s: string, i: number) => s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57

/** The text between [ and ] → the short form, e.g. "[2001:db8::1]". */
function parseIPv6(s: string): string {
  const a = [0, 0, 0, 0, 0, 0, 0, 0]
  let piece = 0
  let compress = -1
  let i = 0
  if (s[0] === ":") {
    if (s[1] !== ":") fail()
    i = 2
    compress = ++piece
  }
  while (i < s.length) {
    if (piece === 8) fail()
    if (s[i] === ":") {
      if (compress !== -1) fail()
      i++
      compress = ++piece
      continue
    }
    let value = 0
    let len = 0
    while (len < 4 && i < s.length && isHex(s.charCodeAt(i))) (value = value * 16 + parseInt(s[i]!, 16)), i++, len++
    if (s[i] === ".") {
      // An IPv4 address at the end, e.g. ::ffff:1.2.3.4
      if (len === 0 || piece > 6) fail()
      i -= len
      let seen = 0
      while (i < s.length) {
        let v4 = -1
        if (seen > 0) {
          if (s[i] === "." && seen < 4) i++
          else fail()
        }
        if (!isDigitAt(s, i)) fail()
        while (isDigitAt(s, i)) {
          const n = s.charCodeAt(i) - 48
          if (v4 === -1) v4 = n
          else if (v4 === 0) fail()
          else v4 = v4 * 10 + n
          if (v4 > 255) fail()
          i++
        }
        a[piece] = a[piece]! * 256 + v4
        seen++
        if (seen === 2 || seen === 4) piece++
      }
      if (seen !== 4) fail()
      break
    } else if (s[i] === ":") {
      i++
      if (i >= s.length) fail()
    } else if (i < s.length) fail()
    a[piece++] = value
  }
  if (compress !== -1) {
    let swaps = piece - compress
    piece = 7
    while (piece !== 0 && swaps > 0) {
      const t = a[compress + swaps - 1]!
      ;(a[compress + swaps - 1] = a[piece]!), (a[piece] = t)
      piece--, swaps--
    }
  } else if (piece !== 8) fail()
  // Serialize: the first longest run of 2+ zero pieces becomes "::".
  let best = -1
  let bestLen = 1
  for (let j = 0; j < 8; ) {
    let k = j
    while (k < 8 && a[k] === 0) k++
    if (k - j > bestLen) (best = j), (bestLen = k - j)
    j = k === j ? j + 1 : k
  }
  let out = ""
  for (let j = 0; j < 8; j++) {
    if (j === best) {
      out += j === 0 ? "::" : ":"
      j += bestLen - 1
      continue
    }
    out += a[j]!.toString(16) + (j < 7 ? ":" : "")
  }
  return "[" + out + "]"
}

function parseHost(input: string, opaque: boolean): string {
  if (input[0] === "[") {
    if (input[input.length - 1] !== "]") fail()
    return parseIPv6(input.slice(1, -1))
  }
  if (opaque) {
    if (/[\0\t\n\r #/:<>?@[\\\]^|]/.test(input)) fail()
    return encode(input, C0)
  }
  const domain = decode(input)
  // IDNA (punycode + Unicode tables) is left out to keep the bundle small. See the note at the top.
  if (/[^\0-\x7f]/.test(domain)) throw new TypeError(`URL: non-ASCII host names are not supported ("${domain}")`)
  const host = domain.toLowerCase()
  if (host === "" || /[\0-\x20#%/:<>?@[\\\]^|\x7f]/.test(host)) fail()
  return endsInNumber(host) ? parseIPv4(host) : host
}

// ---- the parser (WHATWG "basic URL parser") ----

// The parser states, named as in the standard.
const S = {
  SchemeStart: 1, Scheme: 2, NoScheme: 3, SpecialRelativeOrAuthority: 4, PathOrAuthority: 5, Relative: 6,
  RelativeSlash: 7, SpecialAuthoritySlashes: 8, SpecialAuthorityIgnoreSlashes: 9, Authority: 10, Host: 11,
  Hostname: 12, Port: 13, File: 14, FileSlash: 15, FileHost: 16, PathStart: 17, Path: 18, OpaquePath: 19,
  Query: 20, Fragment: 21,
} as const
type S = (typeof S)[keyof typeof S]

const isAlpha = (c: string | undefined) => c !== undefined && /^[a-zA-Z]$/.test(c)
const isDriveLetter = (s: string) => s.length === 2 && isAlpha(s[0]) && (s[1] === ":" || s[1] === "|")
const isNormalDriveLetter = (s: string) => s.length === 2 && isAlpha(s[0]) && s[1] === ":"
const isSingleDot = (s: string) => s === "." || s.toLowerCase() === "%2e"
const isDoubleDot = (s: string) => /^(\.|%2e)(\.|%2e)$/i.test(s)

/** cps[p..] starts with "C:" or "C|" followed by the end or one of / \ ? #. */
function startsWithDriveLetter(cps: string[], p: number): boolean {
  return cps.length - p >= 2 && isDriveLetter(cps[p]! + cps[p + 1]!) && (cps.length - p === 2 || "/\\?#".includes(cps[p + 2]!))
}

function shorten(u: Rec): void {
  const path = u.path as string[]
  if (u.scheme === "file" && path.length === 1 && isNormalDriveLetter(path[0]!)) return
  path.pop()
}

function basicParse(input: string, base: Rec | null, url?: Rec, override?: S): Rec {
  if (!url) {
    url = { scheme: "", username: "", password: "", host: null, port: null, path: [], query: null, fragment: null }
    input = input.replace(/^[\0-\x20]+|[\0-\x20]+$/g, "")
  }
  const u = url
  const cps = Array.from(input.replace(/[\t\n\r]/g, ""))
  const special = () => isSpecial(u)
  const path = () => u.path as string[]
  let state = override || S.SchemeStart
  let buf = ""
  let atSeen = false
  let inBrackets = false
  let passwordSeen = false
  for (let p = 0; ; p++) {
    const c = cps[p] // undefined = the end
    const endOfAuthority = c === undefined || c === "/" || c === "?" || c === "#" || (c === "\\" && special())
    switch (state) {
      case S.SchemeStart:
        if (isAlpha(c)) (buf += c!.toLowerCase()), (state = S.Scheme)
        else if (!override) (state = S.NoScheme), p--
        else fail()
        break
      case S.Scheme:
        if (c !== undefined && /^[a-zA-Z0-9+\-.]$/.test(c)) buf += c.toLowerCase()
        else if (c === ":") {
          if (override) {
            // The protocol setter can't switch between special and non-special, or give file: a port or user.
            if (isSpecial(u) !== (buf in SPECIAL)) return u
            if ((u.username || u.password || u.port !== null) && buf === "file") return u
            if (u.scheme === "file" && u.host === "") return u
          }
          u.scheme = buf
          if (override) {
            if (u.port === SPECIAL[u.scheme]) u.port = null
            return u
          }
          buf = ""
          if (u.scheme === "file") state = S.File
          else if (special() && base && base.scheme === u.scheme) state = S.SpecialRelativeOrAuthority
          else if (special()) state = S.SpecialAuthoritySlashes
          else if (cps[p + 1] === "/") (state = S.PathOrAuthority), p++
          else (u.path = ""), (state = S.OpaquePath)
        } else if (!override) (buf = ""), (state = S.NoScheme), (p = -1)
        else fail()
        break
      case S.NoScheme:
        if (!base || (typeof base.path === "string" && c !== "#")) fail()
        if (typeof base.path === "string") {
          ;(u.scheme = base.scheme), (u.path = base.path), (u.query = base.query), (u.fragment = "")
          state = S.Fragment
        } else (state = base.scheme === "file" ? S.File : S.Relative), p--
        break
      case S.SpecialRelativeOrAuthority:
        if (c === "/" && cps[p + 1] === "/") (state = S.SpecialAuthorityIgnoreSlashes), p++
        else (state = S.Relative), p--
        break
      case S.PathOrAuthority:
        if (c === "/") state = S.Authority
        else (state = S.Path), p--
        break
      case S.Relative:
        u.scheme = base!.scheme
        if (c === "/" || (c === "\\" && special())) state = S.RelativeSlash
        else {
          ;(u.username = base!.username), (u.password = base!.password), (u.host = base!.host), (u.port = base!.port)
          ;(u.path = (base!.path as string[]).slice()), (u.query = base!.query)
          if (c === "?") (u.query = ""), (state = S.Query)
          else if (c === "#") (u.fragment = ""), (state = S.Fragment)
          else if (c !== undefined) (u.query = null), shorten(u), (state = S.Path), p--
        }
        break
      case S.RelativeSlash:
        if (special() && (c === "/" || c === "\\")) state = S.SpecialAuthorityIgnoreSlashes
        else if (c === "/") state = S.Authority
        else {
          ;(u.username = base!.username), (u.password = base!.password), (u.host = base!.host), (u.port = base!.port)
          ;(state = S.Path), p--
        }
        break
      case S.SpecialAuthoritySlashes:
        state = S.SpecialAuthorityIgnoreSlashes
        if (c === "/" && cps[p + 1] === "/") p++
        else p--
        break
      case S.SpecialAuthorityIgnoreSlashes:
        if (c !== "/" && c !== "\\") (state = S.Authority), p--
        break
      case S.Authority:
        if (c === "@") {
          if (atSeen) buf = "%40" + buf
          atSeen = true
          for (const ch of buf) {
            if (ch === ":" && !passwordSeen) passwordSeen = true
            else if (passwordSeen) u.password += encode(ch, USERINFO)
            else u.username += encode(ch, USERINFO)
          }
          buf = ""
        } else if (endOfAuthority) {
          if (atSeen && buf === "") fail()
          p -= Array.from(buf).length + 1
          ;(buf = ""), (state = S.Host)
        } else buf += c
        break
      case S.Host:
      case S.Hostname:
        if (override && u.scheme === "file") (state = S.FileHost), p--
        else if (c === ":" && !inBrackets) {
          if (buf === "" || override === S.Hostname) fail()
          ;(u.host = parseHost(buf, !special())), (buf = ""), (state = S.Port)
        } else if (endOfAuthority) {
          p--
          if (special() && buf === "") fail()
          if (override && buf === "" && (u.username || u.password || u.port !== null)) fail()
          ;(u.host = parseHost(buf, !special())), (buf = ""), (state = S.PathStart)
          if (override) return u
        } else {
          if (c === "[") inBrackets = true
          if (c === "]") inBrackets = false
          buf += c
        }
        break
      case S.Port:
        if (c !== undefined && c >= "0" && c <= "9") buf += c
        else if (endOfAuthority || override) {
          if (buf !== "") {
            const port = parseInt(buf, 10)
            if (port > 65535) fail()
            u.port = port === SPECIAL[u.scheme] ? null : port
            buf = ""
            if (override) return u
          }
          if (override) fail()
          ;(state = S.PathStart), p--
        } else fail()
        break
      case S.File:
        ;(u.scheme = "file"), (u.host = "")
        if (c === "/" || c === "\\") state = S.FileSlash
        else if (base && base.scheme === "file") {
          ;(u.host = base.host), (u.path = (base.path as string[]).slice()), (u.query = base.query)
          if (c === "?") (u.query = ""), (state = S.Query)
          else if (c === "#") (u.fragment = ""), (state = S.Fragment)
          else if (c !== undefined) {
            u.query = null
            if (!startsWithDriveLetter(cps, p)) shorten(u)
            else u.path = []
            ;(state = S.Path), p--
          }
        } else (state = S.Path), p--
        break
      case S.FileSlash:
        if (c === "/" || c === "\\") state = S.FileHost
        else {
          if (base && base.scheme === "file") {
            u.host = base.host
            const first = (base.path as string[])[0]
            if (!startsWithDriveLetter(cps, p) && first !== undefined && isNormalDriveLetter(first)) path().push(first)
          }
          ;(state = S.Path), p--
        }
        break
      case S.FileHost:
        if (c === undefined || "/\\?#".includes(c)) {
          p--
          if (!override && isDriveLetter(buf)) state = S.Path // buf is kept: the path state uses it
          else if (buf === "") {
            u.host = ""
            if (override) return u
            state = S.PathStart
          } else {
            const host = parseHost(buf, !special())
            u.host = host === "localhost" ? "" : host
            if (override) return u
            ;(buf = ""), (state = S.PathStart)
          }
        } else buf += c
        break
      case S.PathStart:
        if (special()) {
          state = S.Path
          if (c !== "/" && c !== "\\") p--
        } else if (!override && c === "?") (u.query = ""), (state = S.Query)
        else if (!override && c === "#") (u.fragment = ""), (state = S.Fragment)
        else if (c !== undefined) {
          state = S.Path
          if (c !== "/") p--
        } else if (override && u.host === null) path().push("")
        break
      case S.Path:
        if (c === undefined || c === "/" || (c === "\\" && special()) || (!override && (c === "?" || c === "#"))) {
          const slash = c === "/" || (c === "\\" && special())
          if (isDoubleDot(buf)) {
            shorten(u)
            if (!slash) path().push("")
          } else if (isSingleDot(buf) && !slash) path().push("")
          else if (!isSingleDot(buf)) {
            if (u.scheme === "file" && path().length === 0 && isDriveLetter(buf)) buf = buf[0] + ":"
            path().push(buf)
          }
          buf = ""
          if (c === "?") (u.query = ""), (state = S.Query)
          if (c === "#") (u.fragment = ""), (state = S.Fragment)
        } else buf += encode(c, PATH)
        break
      case S.OpaquePath:
        if (c === "?") (u.query = ""), (state = S.Query)
        else if (c === "#") (u.fragment = ""), (state = S.Fragment)
        // A space just before ? or # is encoded, so it can't be lost at the end of the path later.
        else if (c === " ") u.path += cps[p + 1] === "?" || cps[p + 1] === "#" ? "%20" : " "
        else if (c !== undefined) u.path += encode(c, C0)
        break
      case S.Query:
        if (c === undefined || (!override && c === "#")) {
          u.query += encode(buf, special() ? SPECIAL_QUERY : QUERY)
          buf = ""
          if (c === "#") (u.fragment = ""), (state = S.Fragment)
        } else buf += c
        break
      case S.Fragment:
        if (c !== undefined) u.fragment += encode(c, FRAGMENT)
        break
    }
    if (p >= cps.length) return u
  }
}


const pathname = (u: Rec) => (typeof u.path === "string" ? u.path : u.path.map((s) => "/" + s).join(""))

function serialize(u: Rec): string {
  let out = u.scheme + ":"
  if (u.host !== null) {
    out += "//"
    if (u.username || u.password) out += u.username + (u.password ? ":" + u.password : "") + "@"
    out += u.host + (u.port !== null ? ":" + u.port : "")
  } else if (typeof u.path !== "string" && u.path.length > 1 && u.path[0] === "") out += "/." // keeps "//" out of the host
  out += pathname(u)
  if (u.query !== null) out += "?" + u.query
  if (u.fragment !== null) out += "#" + u.fragment
  return out
}

/** Runs `parse`, turning a parser failure into the web's TypeError. */
function orThrow<T>(parse: () => T, what: unknown): T {
  try {
    return parse()
  } catch (e) {
    throw e === FAIL ? new TypeError(`Invalid URL: ${what}`) : e
  }
}

/** The API parser: a string (and an optional base) → parts, or a TypeError. */
function parseOrThrow(url: unknown, base?: unknown): Rec {
  const b = base === undefined ? null : orThrow(() => basicParse(toUSV(base), null), `base "${String(base)}"`)
  return orThrow(() => basicParse(toUSV(url), b), `"${String(url)}"`)
}

export class ZnURL {
  /** @internal */
  _u: Rec
  /** @internal */
  _params = new ZnURLSearchParams()

  constructor(url: string | ZnURL, base?: string | ZnURL) {
    this._u = parseOrThrow(url, base)
    this._params._list = parseForm(this._u.query ?? "") // not the constructor: a "?" at the start of the query is kept
    this._params._url = this
  }

  static canParse(url: string, base?: string): boolean {
    return ZnURL.parse(url, base) !== null
  }

  static parse(url: string, base?: string): ZnURL | null {
    try {
      return new ZnURL(url, base)
    } catch {
      return null
    }
  }

  /**
   * A setter: runs the parser on this URL from `state`. A bad value is ignored (no throw), but what was set before
   * the bad part stays, like the web: `host = "h:99999"` sets the host "h" and keeps the old port.
   */
  private _set(value: unknown, state: S, prepare?: (u: Rec) => void): void {
    prepare?.(this._u)
    try {
      basicParse(toUSV(value), null, this._u, state)
    } catch (e) {
      if (e !== FAIL) throw e
    }
  }

  /** No user, password or port on hostless and file: URLs. */
  private get _noCredentials(): boolean {
    return this._u.host === null || this._u.host === "" || this._u.scheme === "file"
  }

  /** Host setters do nothing on URLs with an opaque path (mailto:a@b). */
  private get _opaque(): boolean {
    return typeof this._u.path === "string"
  }

  get href(): string {
    return serialize(this._u)
  }
  set href(value: string) {
    this._u = parseOrThrow(value)
    this._params._list = parseForm(this._u.query ?? "")
  }

  get origin(): string {
    const u = this._u
    if (u.scheme === "blob") {
      // blob:https://a.com/uuid has the origin of the URL inside it.
      const inner = ZnURL.parse(pathname(u))
      return inner && (inner.protocol === "http:" || inner.protocol === "https:") ? inner.origin : "null"
    }
    if (!isSpecial(u) || u.scheme === "file") return "null"
    return u.scheme + "://" + this.host
  }

  get protocol(): string { return this._u.scheme + ":" }
  set protocol(value: string) { this._set(toUSV(value) + ":", S.SchemeStart) }

  get username(): string { return this._u.username }
  set username(value: string) { if (!this._noCredentials) this._u.username = encode(toUSV(value), USERINFO) }

  get password(): string { return this._u.password }
  set password(value: string) { if (!this._noCredentials) this._u.password = encode(toUSV(value), USERINFO) }

  get host(): string { return (this._u.host ?? "") + (this._u.port !== null ? ":" + this._u.port : "") }
  set host(value: string) { if (!this._opaque) this._set(value, S.Host) }

  get hostname(): string { return this._u.host ?? "" }
  set hostname(value: string) { if (!this._opaque) this._set(value, S.Hostname) }

  get port(): string { return this._u.port === null ? "" : String(this._u.port) }
  set port(value: string) {
    const v = toUSV(value)
    if (this._noCredentials) return
    if (v === "") this._u.port = null
    else this._set(v, S.Port)
  }

  get pathname(): string { return pathname(this._u) }
  set pathname(value: string) { if (!this._opaque) this._set(value, S.PathStart, (u) => (u.path = [])) }

  get search(): string { return this._u.query ? "?" + this._u.query : "" }
  set search(value: string) {
    const v = toUSV(value)
    const input = v[0] === "?" ? v.slice(1) : v
    if (v === "") this._u.query = null
    else this._set(input, S.Query, (u) => (u.query = ""))
    this._params._list = parseForm(input)
  }

  get searchParams(): ZnURLSearchParams { return this._params }

  get hash(): string { return this._u.fragment ? "#" + this._u.fragment : "" }
  set hash(value: string) {
    const v = toUSV(value)
    if (v === "") this._u.fragment = null
    else this._set(v[0] === "#" ? v.slice(1) : v, S.Fragment, (u) => (u.fragment = ""))
  }

  toString(): string { return this.href }
  toJSON(): string { return this.href }
}

// ---- URLSearchParams ----

/** application/x-www-form-urlencoded → pairs. "+" is a space. */
function parseForm(s: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const part of s.split("&")) {
    if (part === "") continue
    const at = part.indexOf("=")
    const name = at === -1 ? part : part.slice(0, at)
    const value = at === -1 ? "" : part.slice(at + 1)
    out.push([decode(name.replace(/\+/g, " ")), decode(value.replace(/\+/g, " "))])
  }
  return out
}

export type URLSearchParamsInit = string | Iterable<readonly [string, string]> | Record<string, string> | ZnURLSearchParams

export class ZnURLSearchParams {
  /** @internal The pairs, in order. */
  _list: Array<[string, string]> = []
  /** @internal The URL this belongs to (url.searchParams); changes are written back to its query. */
  _url: ZnURL | null = null

  constructor(init: URLSearchParamsInit = "") {
    if (typeof init === "object" && init !== null) {
      if (typeof (init as any)[Symbol.iterator] === "function") {
        for (const pair of init as Iterable<readonly [string, string]>) {
          const p = Array.from(pair as Iterable<string>)
          if (p.length !== 2) throw new TypeError("URLSearchParams: each entry must be a [name, value] pair")
          this._list.push([toUSV(p[0]), toUSV(p[1])])
        }
      } else {
        for (const k of Object.keys(init)) this._list.push([toUSV(k), toUSV((init as Record<string, string>)[k])])
      }
    } else {
      const s = toUSV(init) // null → "null", like the web
      this._list = parseForm(s[0] === "?" ? s.slice(1) : s)
    }
  }

  /** Writes the pairs back to the URL's query (empty → no "?"). */
  private _update(): void {
    const q = this.toString()
    if (this._url) this._url._u.query = q === "" ? null : q
  }

  get size(): number {
    return this._list.length
  }

  append(name: string, value: string): void {
    this._list.push([toUSV(name), toUSV(value)])
    this._update()
  }

  /** Removes all pairs with this name (and this value, when given). */
  delete(name: string, value?: string): void {
    const [n, v] = [toUSV(name), value === undefined ? undefined : toUSV(value)]
    this._list = this._list.filter(([k, x]) => k !== n || (v !== undefined && x !== v))
    this._update()
  }

  get(name: string): string | null {
    const n = toUSV(name)
    return this._list.find(([k]) => k === n)?.[1] ?? null
  }

  getAll(name: string): string[] {
    const n = toUSV(name)
    return this._list.filter(([k]) => k === n).map(([, v]) => v)
  }

  has(name: string, value?: string): boolean {
    const [n, v] = [toUSV(name), value === undefined ? undefined : toUSV(value)]
    return this._list.some(([k, x]) => k === n && (v === undefined || x === v))
  }

  /** Sets the first pair with this name and removes the others; appends when there is none. */
  set(name: string, value: string): void {
    const [n, v] = [toUSV(name), toUSV(value)]
    const at = this._list.findIndex(([k]) => k === n)
    if (at === -1) this._list.push([n, v])
    else this._list = this._list.filter(([k], i) => k !== n || i === at).map((p) => (p[0] === n ? [n, v] : p))
    this._update()
  }

  /** Sorts by name (UTF-16 code units); pairs with the same name keep their order. */
  sort(): void {
    const indexed = this._list.map((pair, i) => [pair, i] as const)
    indexed.sort(([a, i], [b, j]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : i - j))
    this._list = indexed.map(([pair]) => pair)
    this._update()
  }

  toString(): string {
    return this._list.map(([k, v]) => encode(k, FORM, true) + "=" + encode(v, FORM, true)).join("&")
  }

  forEach(fn: (value: string, name: string, params: ZnURLSearchParams) => void, thisArg?: unknown): void {
    for (let i = 0; i < this._list.length; i++) fn.call(thisArg, this._list[i]![1], this._list[i]![0], this)
  }

  // Live, like the web: pairs added while looping are seen.
  *entries(): IterableIterator<[string, string]> {
    for (let i = 0; i < this._list.length; i++) yield [this._list[i]![0], this._list[i]![1]]
  }
  *keys(): IterableIterator<string> {
    for (const [k] of this.entries()) yield k
  }
  *values(): IterableIterator<string> {
    for (const [, v] of this.entries()) yield v
  }
  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries()
  }
}

export function installUrl(): void {
  const g = globalThis as any
  if (typeof g.URL === "undefined") g.URL = ZnURL
  if (typeof g.URLSearchParams === "undefined") g.URLSearchParams = ZnURLSearchParams
}
