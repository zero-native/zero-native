import { afterEach, describe, expect, test } from "bun:test"
import { installUrl, ZnURL, ZnURLSearchParams } from "../src/url"

// Bun has a real WHATWG URL / URLSearchParams, so ours is checked against it on many inputs.
const WebURL = globalThis.URL
const WebParams = globalThis.URLSearchParams

const FIELDS = ["href", "origin", "protocol", "username", "password", "host", "hostname", "port", "pathname", "search", "hash"] as const
const fields = (u: any) => Object.fromEntries(FIELDS.map((f) => [f, u[f]]))

/** Both parse to the same parts, or both throw a TypeError. */
function same(input: string, base?: string): void {
  let want: any
  try {
    want = fields(new WebURL(input, base))
  } catch (e) {
    expect(e).toBeInstanceOf(TypeError)
    expect(() => new ZnURL(input, base)).toThrow(TypeError)
    expect(ZnURL.canParse(input, base)).toBe(false)
    expect(ZnURL.parse(input, base)).toBeNull()
    return
  }
  expect({ input, base, ...fields(new ZnURL(input, base)) }).toEqual({ input, base, ...want })
  expect(ZnURL.canParse(input, base)).toBe(true)
  expect(String(ZnURL.parse(input, base))).toBe(want.href)
}

const ABSOLUTE = [
  "https://example.com",
  "HTTPS://EXAMPLE.COM:443/A/B?Q=1#F",
  "http://example.com:80/",
  "http://example.com:8080/x",
  "http://example.com:/x",
  "http://example.com:65535/",
  "http://example.com:65536/",
  "http://example.com:00080/",
  "http://example.com:8a/",
  "ws://h:80/",
  "wss://h:443/",
  "ftp://h:21/",
  "http://user:pass@example.com/",
  "http://user@example.com/",
  "http://:pass@example.com/",
  "http://us er:pa ss@example.com/",
  "http://a@b@example.com/",
  "http://a:b:c@example.com/",
  "http://@example.com/",
  "http://user:@example.com/",
  "http://user%40x:p%3A@h/",
  "http://ü:é@h/",
  "http://[::1]/",
  "http://[::1]:8080/",
  "http://[2001:DB8:0:0:0:0:0:1]/",
  "http://[2001:db8::0:1:0:0:1]/",
  "http://[1:0:0:2:0:0:0:3]/",
  "http://[::ffff:192.168.1.1]/",
  "http://[0:0:0:0:0:0:0:0]/",
  "http://[1:2:3:4:5:6:7:8]/",
  "http://[1:2:3:4:5:6:7:8:9]/",
  "http://[::1::2]/",
  "http://[:1]/",
  "http://[1:2:3:4:5:6:1.2.3.4]/",
  "http://[::1.2.3.256]/",
  "http://[::01.2.3.4]/",
  "http://[::1/",
  "http://[::1]x/",
  "http://192.168.0.1/",
  "http://0x7f.1/",
  "http://2130706433/",
  "http://0177.0.0.1/",
  "http://127.1/",
  "http://1.2.3.4./",
  "http://256.1.1.1/",
  "http://1.2.3.4.5/",
  "http://1..2/",
  "http://09.1/",
  "http://0x/",
  "http://4294967295/",
  "http://4294967296/",
  "http://a.b.c.1x/",
  "http://example.123/",
  "http://exa%41mple.com/",
  "http://exa%2Fmple.com/",
  "http://exa mple.com/",
  "http://ex<ample.com/",
  "http://ex_ample.com/",
  "http://%zz/",
  "http:///example.com/",
  "http:\\\\example.com\\a\\b",
  "http:example.com/a",
  "http://",
  "http:",
  "https://example.com/a/./b/../c",
  "https://example.com/a/b/../../../..",
  "https://example.com/a/%2e/b/%2E%2e/c",
  "https://example.com/a/.%2e/b",
  "https://example.com/a/..",
  "https://example.com/a/.",
  "https://example.com/a b/ü/%/%41/^{}`|\"<>",
  "https://example.com/?a b&c=ü&d='\"<>`{}#x y`ü<>",
  "https://example.com/?%zz%41",
  "https://example.com/#a b'\"`<>ü%",
  "https://example.com/😀?😀#😀",
  "https://example.com/\ud800?\udc00#\ud83d",
  "  \t https://exa\nmple.com/a\tb \n ",
  "\u0000https://example.com/\u001f",
  "https://example.com/\u007f",
  "https://example.com??a#b#c",
  "https://example.com/#",
  "https://example.com/?",
  "https://example.com/?#",
  "file:///C:/Users/a/b.txt",
  "file:///c|/x",
  "file://localhost/etc/passwd",
  "file://host.example/share/x",
  "file:/x/y",
  "file:x",
  "file://C:/x",
  "file:///C:/../x",
  "FILE:///A",
  "file://[::1]/x",
  "upi://pay?pa=a@b&am=10.00&tn=Hello%20World",
  "upi://pay?pa=merchant@upi&pn=Chai Wala&am=₹10&cu=INR",
  "mailto:a@b.c?subject=x y",
  "mailto:a@b.c?subject=x y#frag",
  "tel:+911234",
  "zn://sample/offer/5?x=1",
  "zn://sample",
  "zn:///path",
  "intent://scan/#Intent;scheme=zxing;end",
  "myapp://Host.Example/Path/./x/../y?Q#H",
  "myapp://h:99/",
  "myapp://u:p@h/",
  "myapp://h ost/",
  "myapp://h%20ost/",
  "myapp://ü/",
  "myapp://[::1]/",
  "myapp://",
  "myapp:",
  "sc:a b  ?q",
  "sc:a b #x",
  "sc:\u0001ü ",
  "sc:/a/b/../c",
  "sc:/.//a",
  "sc:a/..",
  "javascript:alert(1)",
  "data:text/plain,hello world",
  "blob:https://example.com/550e8400",
  "blob:sc:x",
  "about:blank",
  "a+b-c.d:x",
  "1abc:x",
  "constructor:x",
  "constructor://h:80/",
  "",
  " ",
  "/just/a/path",
  "//host/path",
  "?q",
  "#h",
  "ht tp://x/",
  "http://a:b@/",
  "http://a@/",
]

describe("URL against Bun", () => {
  for (const input of ABSOLUTE) test(JSON.stringify(input), () => same(input))
})

const BASE = "https://user:pw@example.com:8443/a/b/c?q=1#f"
const RELATIVE = [
  "",
  "d",
  "./d",
  "../d",
  "../../d",
  "../../../../d",
  "/d",
  "//other.com/d",
  "///other.com/d",
  "\\d",
  "..\\..\\d",
  "\\\\other.com\\d",
  "?x=2",
  "#g",
  "?",
  "#",
  "../a?b#c",
  ".",
  "..",
  "./",
  "../",
  "d/./e/../f",
  "%2e%2e/x",
  "https:d",
  "https:/d",
  "http:d",
  "mailto:x",
  "zn://x/y",
  "  d  ",
  "d\te\nf",
]

describe("relative URLs against Bun", () => {
  for (const input of RELATIVE) test(JSON.stringify(input) + " on https base", () => same(input, BASE))
  const bases = ["file:///C:/a/b", "file://host/a/b", "file:///a/b", "zn://sample/a/b", "mailto:a@b.c", "sc:x/y", "zn:/a/b"]
  const inputs = ["c", "../c", "/c", "C|/x", "//h/x", "?q", "#f", "", "a\\b", "file:c", "/C:/x", "C:"]
  for (const base of bases) for (const input of inputs) test(`${JSON.stringify(input)} on ${base}`, () => same(input, base))
  test("bad base or no base", () => {
    same("a", "not a url")
    same("a")
    same("#a", "mailto:x")
    same("a", "mailto:x")
    expect(() => new ZnURL("a", "nope")).toThrow("Invalid URL")
    expect(() => new ZnURL("a")).toThrow('Invalid URL: "a"')
  })
  test("a URL object as base", () => {
    expect(new ZnURL("x", new ZnURL(BASE)).href).toBe(new WebURL("x", BASE).href)
  })
})

describe("non-ASCII host names (no IDNA here, on purpose)", () => {
  for (const input of ["https://café.com/", "https://例え.jp/", "http://EXAMPLE。com/", "https://caf%C3%A9.com/"]) {
    test(input, () => {
      expect(() => new WebURL(input)).not.toThrow()
      expect(() => new ZnURL(input)).toThrow("URL: non-ASCII host names are not supported")
    })
  }
  test("non-special schemes keep them, percent-encoded", () => same("myapp://café/x"))
  test("canParse says false", () => expect(ZnURL.canParse("https://café.com/")).toBe(false))
})

// Where Bun 1.4 does not follow the URL Standard, ours follows the standard: [start, setter, value, our href].
const BUN_DIFFERS: Array<[string, string, string, string]> = [
  // A default port given to the host setter removes the old port (WPT: "Port number is removed if new port is
  // scheme default"). Bun keeps 8443.
  ["https://user:pw@example.com:8443/a/b?q=1#f", "host", "OTHER.com:443", "https://user:pw@other.com/a/b?q=1#f"],
  // The host is set before the port fails, and a failed port leaves the old port. Bun drops the port.
  ["https://user:pw@example.com:8443/a/b?q=1#f", "host", "h:99999", "https://user:pw@h:8443/a/b?q=1#f"],
  // file: URLs have no port, so "h:..." is not a valid file host and nothing changes. Bun sets the host "h".
  ["file:///C:/x", "host", "h:99999", "file:///C:/x"],
  ["file:///C:/x", "host", "h:", "file:///C:/x"],
]

describe("where Bun differs from the URL Standard", () => {
  for (const [start, field, value, href] of BUN_DIFFERS) {
    test(`${field} = ${JSON.stringify(value)} on ${start}`, () => {
      const u = new ZnURL(start) as any
      u[field] = value
      expect(u.href).toBe(href)
    })
  }
  test("a backslash is a normal character in non-special paths, so '..\\x' is not '..'", () => {
    // Bun gives zn://sample/x: it treats "..\" as ".." here.
    expect(new ZnURL("..\\x", "zn://sample/a/b").href).toBe("zn://sample/a/..\\x")
    expect(new ZnURL("..\\x", "zn:/a/b").href).toBe("zn:/a/..\\x")
  })
})

describe("setters against Bun", () => {
  const starts = ["https://user:pw@example.com:8443/a/b?q=1#f", "http://h/", "file:///C:/x", "mailto:a@b.c", "zn://sample/x?y#z", "sc:/p", "myapp://"]
  const values: Record<string, string[]> = {
    href: ["http://new.com/x", "zn://a/b"],
    protocol: ["http", "https:", "HTTP", "ftp:x", "zn", "file", "mailto", "1x", "", "ws://", "wss"],
    username: ["", "me", "a b:c@d/ü", "%41"],
    password: ["", "secret", "a b:c@d/ü"],
    host: ["", "other.com", "other.com:81", "OTHER.com:443", "[::1]:5", "a b", "h:99999", "h:12x", "x/y", "x?y", "x#y", "café.org".replace("é", "e"), "h:"],
    hostname: ["", "other.com", "other.com:81", "[::1]", "1.2", "a b", "x/y", "localhost"],
    port: ["", "81", "443", "80", "8443x", "x", "99999", "-1", "0", " 81", "1\t2"],
    pathname: ["", "/", "x", "/a/../b", "a b/ü/?#", "\\a\\b", "//x", "/./."],
    search: ["", "?", "a=1", "?a=1&b=2", "a b#c'ü", "??x"],
    hash: ["", "#", "x", "#x y`ü", "##"],
  }
  for (const start of starts) {
    for (const [field, list] of Object.entries(values)) {
      test(`${field} on ${start}`, () => {
        for (const v of list) {
          if (BUN_DIFFERS.some(([s, f, x]) => s === start && f === field && x === v)) continue
          const want = new WebURL(start)
          const got = new ZnURL(start)
          ;(want as any)[field] = v
          ;(got as any)[field] = v
          expect({ field, v, ...fields(got) }).toEqual({ field, v, ...fields(want) })
        }
      })
    }
  }
  test("href setter throws on a bad URL and keeps the old one", () => {
    const u = new ZnURL("https://a.com/")
    expect(() => (u.href = "nope")).toThrow(TypeError)
    expect(u.href).toBe("https://a.com/")
  })
  test("toString and toJSON", () => {
    const u = new ZnURL("HTTPS://A.com/x")
    expect(u.toString()).toBe("https://a.com/x")
    expect(JSON.stringify({ u })).toBe('{"u":"https://a.com/x"}')
  })
})

describe("searchParams is live", () => {
  test("changing searchParams updates search and href", () => {
    for (const U of [WebURL, ZnURL] as any[]) {
      const u = new U("https://a.com/p?x=1#h")
      u.searchParams.append("name", "Chai Wala ₹")
      u.searchParams.set("x", "2")
      expect(u.search).toBe("?x=2&name=Chai+Wala+%E2%82%B9")
      expect(u.href).toBe("https://a.com/p?x=2&name=Chai+Wala+%E2%82%B9#h")
      u.searchParams.delete("x")
      u.searchParams.delete("name")
      expect(u.href).toBe("https://a.com/p#h")
    }
  })
  test("setting search, href or hash updates searchParams", () => {
    for (const U of [WebURL, ZnURL] as any[]) {
      const u = new U("https://a.com/?a=1")
      const sp = u.searchParams
      u.search = "?b=2&b=3"
      expect(sp.getAll("b")).toEqual(["2", "3"])
      expect(sp.has("a")).toBe(false)
      u.href = "https://b.com/?c=%20+x"
      expect(u.searchParams).toBe(sp)
      expect(sp.get("c")).toBe("  x")
      u.search = ""
      expect(sp.size).toBe(0)
    }
  })
  test("a query that starts with ? is kept", () => {
    expect([...new ZnURL("http://h/??a=1").searchParams]).toEqual([...new WebURL("http://h/??a=1").searchParams])
  })
  test("sort through searchParams", () => {
    const want = new WebURL("zn://x/?b=1&a=2&b=0&a=1")
    const got = new ZnURL("zn://x/?b=1&a=2&b=0&a=1")
    want.searchParams.sort()
    got.searchParams.sort()
    expect(got.href).toBe(want.href)
  })
  test("an opaque path with a space keeps it when the query goes", () => {
    for (const s of ["sc:a b ?q", "sc:a b ?q#f", "sc:a b #f"]) {
      const want = new WebURL(s)
      const got = new ZnURL(s)
      want.searchParams.delete("q")
      got.searchParams.delete("q")
      want.hash = ""
      got.hash = ""
      expect(got.href).toBe(want.href)
    }
  })
})

describe("URLSearchParams against Bun", () => {
  const strings = [
    "",
    "?",
    "a=1&b=2",
    "?a=1&a=2&b",
    "a+b=c+d",
    "a%20b=c%2Bd",
    "%=%%&%zz=%4",
    "&&a=1&&",
    "=a=b",
    "a==b",
    "=",
    "ü=😀",
    "%C3%BC=%F0%9F%98%80",
    "%FF=%C3&%E2%82=%ED%A0%80&%F0%9F%98=x&%C0%AF=y",
    "a=%E2%82%AC%E2%82",
    "\ud800=\udc00",
    "a=*-._~!'()$,;:@/?[]`^{}|\\\"<># ",
    "z=1&a=2&Z=3&a=1&é=1&e=0&😀=1&\uffff=1",
  ]
  for (const s of strings) {
    test(JSON.stringify(s), () => {
      const want = new WebParams(s)
      const got = new ZnURLSearchParams(s)
      expect(got.toString()).toBe(want.toString())
      expect([...got]).toEqual([...want])
      expect(got.size).toBe(want.size)
      for (const [k] of want) {
        expect(got.get(k)).toBe(want.get(k))
        expect(got.getAll(k)).toEqual(want.getAll(k))
      }
      want.sort()
      got.sort()
      expect(got.toString()).toBe(want.toString())
      // Round trip.
      expect([...new ZnURLSearchParams(got.toString())]).toEqual([...new WebParams(want.toString())])
    })
  }

  test("record, pairs, another params object, undefined and null", () => {
    const inits: any[] = [
      { a: "1", b: "x y", "ü": "₹" },
      [["a", "1"], ["a", "2"], ["b", "="]],
      new Map([["k", "v"]]),
      undefined,
      null,
      42,
    ]
    for (const init of inits) expect(new ZnURLSearchParams(init).toString()).toBe(new WebParams(init).toString())
    expect(new ZnURLSearchParams(new ZnURLSearchParams("a=1&b=2")).toString()).toBe("a=1&b=2")
    expect(() => new ZnURLSearchParams([["a", "b", "c"]] as any)).toThrow(TypeError)
    expect(() => new ZnURLSearchParams([["a"]] as any)).toThrow(TypeError)
  })

  test("append, delete and has with a value, set, getters", () => {
    const ops = (p: any) => {
      p.append("a", "1")
      p.append("a", "2")
      p.append("b", "1")
      p.append("a", "3")
      const out: any[] = [p.has("a", "2"), p.has("a", "9"), p.has("c"), p.get("c"), p.getAll("c")]
      p.delete("a", "2")
      out.push(p.toString())
      p.set("a", "x")
      out.push(p.toString())
      p.set("new", "y z")
      p.delete("b")
      out.push(p.toString(), p.size)
      const seen: any[] = []
      p.forEach(function (this: any, v: string, k: string, self: any) {
        seen.push([k, v, self === p, this])
      }, "ctx")
      out.push(seen, [...p.keys()], [...p.values()], [...p.entries()])
      return out
    }
    expect(ops(new ZnURLSearchParams())).toEqual(ops(new WebParams()))
  })

  test("sort is stable and uses UTF-16 code units", () => {
    const s = "\ufb03=1&\ud83c\udf08=2&b=1&a=1&b=0&a=0&\u00e9=x"
    const want = new WebParams(s)
    const got = new ZnURLSearchParams(s)
    want.sort()
    got.sort()
    expect([...got]).toEqual([...want])
  })

  test("lone surrogates in names and values become U+FFFD", () => {
    const got = new ZnURLSearchParams()
    const want = new WebParams()
    for (const p of [got, want]) p.append("a\ud800", "\udc00b")
    expect(got.toString()).toBe(want.toString())
  })
})

describe("installUrl", () => {
  const saved = { URL: globalThis.URL, URLSearchParams: globalThis.URLSearchParams }
  afterEach(() => {
    globalThis.URL = saved.URL
    globalThis.URLSearchParams = saved.URLSearchParams
  })

  test("keeps an engine's own URL", () => {
    installUrl()
    expect(globalThis.URL).toBe(saved.URL)
    expect(globalThis.URLSearchParams).toBe(saved.URLSearchParams)
  })

  test("fills in when missing", () => {
    delete (globalThis as any).URL
    delete (globalThis as any).URLSearchParams
    installUrl()
    expect(globalThis.URL as any).toBe(ZnURL)
    expect(globalThis.URLSearchParams as any).toBe(ZnURLSearchParams)
  })
})
