import { describe, expect, test } from "bun:test"
import { parseInline, parseMarkdown, type Block } from "../src/parse"

const kinds = (bs: Block[]) => bs.map((b) => b.kind)
const text = (b: Block) => b.runs.map((r) => r.text).join("")

describe("inline", () => {
  test("plain text is one run", () => {
    expect(parseInline("Pay at the counter")).toEqual([{ text: "Pay at the counter" }])
    expect(parseInline("")).toEqual([])
  })

  test("bold, italic, both, strike, underline, code", () => {
    expect(parseInline("Get **₹400** back")).toEqual([{ text: "Get " }, { text: "₹400", bold: true }, { text: " back" }])
    expect(parseInline("__a__ *b* _c_")).toEqual([
      { text: "a", bold: true },
      { text: " " },
      { text: "b", italic: true },
      { text: " " },
      { text: "c", italic: true },
    ])
    expect(parseInline("***x***")).toEqual([{ text: "x", bold: true, italic: true }])
    expect(parseInline("~~₹500~~ ₹400")).toEqual([{ text: "₹500", strike: true }, { text: " ₹400" }])
    expect(parseInline("<u>min ₹99</u>")).toEqual([{ text: "min ₹99", underline: true }])
    expect(parseInline("Code `ZB4K2Q` now")).toEqual([{ text: "Code " }, { text: "ZB4K2Q", code: true }, { text: " now" }])
  })

  test("nested emphasis: italic around bold, bold around italic", () => {
    expect(parseInline("*a **b** c*")).toEqual([
      { text: "a ", italic: true },
      { text: "b", bold: true, italic: true },
      { text: " c", italic: true },
    ])
    expect(parseInline("**a *b***")).toEqual([
      { text: "a ", bold: true },
      { text: "b", bold: true, italic: true },
    ])
  })

  test("unmatched or spaced delimiters stay as text", () => {
    expect(parseInline("2 * 3 = 6")).toEqual([{ text: "2 * 3 = 6" }])
    expect(parseInline("**not closed")).toEqual([{ text: "**not closed" }])
    expect(parseInline("a ** b ** c")).toEqual([{ text: "a ** b ** c" }])
    expect(parseInline("~one~")).toEqual([{ text: "~one~" }])
    expect(parseInline("`open")).toEqual([{ text: "`open" }])
  })

  test("snake_case and amounts with _ stay as text", () => {
    expect(parseInline("use offer_code_new today")).toEqual([{ text: "use offer_code_new today" }])
    expect(parseInline("_a_b")).toEqual([{ text: "_a_b" }])
  })

  test("escapes", () => {
    expect(parseInline("\\*not italic\\*")).toEqual([{ text: "*not italic*" }])
    expect(parseInline("a\\_b")).toEqual([{ text: "a_b" }])
    // Not an escapable character: the backslash stays.
    expect(parseInline("C:\\path")).toEqual([{ text: "C:\\path" }])
  })

  test("code spans keep their content as written", () => {
    expect(parseInline("`**x**`")).toEqual([{ text: "**x**", code: true }])
    expect(parseInline("`` a`b ``")).toEqual([{ text: "a`b", code: true }])
    expect(parseInline("*a `*` b*")).toEqual([
      { text: "a ", italic: true },
      { text: "*", italic: true, code: true },
      { text: " b", italic: true },
    ])
  })

  test("links: text, target, title, bold inside, no nesting", () => {
    expect(parseInline("See [terms](https://example.com/t) here")).toEqual([
      { text: "See " },
      { text: "terms", href: "https://example.com/t" },
      { text: " here" },
    ])
    expect(parseInline('[a](https://x.in/a_(b) "Title")')).toEqual([{ text: "a", href: "https://x.in/a_(b)" }])
    expect(parseInline("[**Shop** now](https://x.in)")).toEqual([
      { text: "Shop", bold: true, href: "https://x.in" },
      { text: " now", href: "https://x.in" },
    ])
    expect(parseInline("[](https://x.in)")).toEqual([{ text: "https://x.in", href: "https://x.in" }])
    expect(parseInline("[a [b](https://y)](https://x)")).toEqual([{ text: "a [b](https://y)", href: "https://x" }])
    expect(parseInline("<https://x.in/a>")).toEqual([{ text: "https://x.in/a", href: "https://x.in/a" }])
  })

  test("not links: no target, empty target, a newline in the target", () => {
    expect(parseInline("[x]")).toEqual([{ text: "[x]" }])
    expect(parseInline("[x] (y)")).toEqual([{ text: "[x] (y)" }])
    expect(parseInline("[x]()")).toEqual([{ text: "x" }])
    expect(parseInline("[x](a\nb)")).toEqual([{ text: "[x](a\nb)" }])
  })

  test("any scheme is passed to the app as written: the app decides", () => {
    expect(parseInline("[pay](upi://pay?pa=a@b)")[0].href).toBe("upi://pay?pa=a@b")
    expect(parseInline("[x](javascript:alert(1))")[0].href).toBe("javascript:alert(1)")
  })

  test("HTML stays text, except <u> and <br>; images show only their alt text", () => {
    expect(parseInline("<b>hi</b><script>x</script>")).toEqual([{ text: "<b>hi</b><script>x</script>" }])
    expect(parseInline("a<br>b<br/>c<BR />d")).toEqual([{ text: "a\nb\nc\nd" }])
    expect(parseInline("![logo](https://x.in/l.png) Ravi")).toEqual([{ text: "logo Ravi" }])
  })

  test("newlines stay", () => {
    expect(parseInline("a\n**b**")).toEqual([{ text: "a\n" }, { text: "b", bold: true }])
  })
})

describe("blocks", () => {
  test("paragraphs split on blank lines; lines inside keep their breaks", () => {
    const bs = parseMarkdown("Line one\nline two\n\n\nNext para")
    expect(kinds(bs)).toEqual(["p", "p"])
    expect(text(bs[0])).toBe("Line one\nline two")
    expect(text(bs[1])).toBe("Next para")
  })

  test("hard breaks: the trailing backslash or spaces go", () => {
    expect(text(parseMarkdown("a\\\nb  \nc")[0])).toBe("a\nb\nc")
  })

  test("headings: # and underlined, levels, closing #s, #tag is text", () => {
    const bs = parseMarkdown("# One\n### Three ###\n#tag\n\nTitle\n=====\nSub\n---")
    expect(bs.map((b) => [b.kind, b.level, text(b)])).toEqual([
      ["h", 1, "One"],
      ["h", 3, "Three"],
      ["p", 0, "#tag"],
      ["h", 1, "Title"],
      ["h", 2, "Sub"],
    ])
    expect(parseMarkdown("#\n## ")).toEqual([])
  })

  test("bullet lists with -, *, + and •; depth from indent", () => {
    const bs = parseMarkdown("- one\n* two\n  - two a\n    + deep\n• three")
    expect(bs.map((b) => [b.kind, b.depth, b.marker, text(b)])).toEqual([
      ["li", 0, "•", "one"],
      ["li", 0, "•", "two"],
      ["li", 1, "◦", "two a"],
      ["li", 2, "▪", "deep"],
      ["li", 0, "•", "three"],
    ])
  })

  test("numbered lists count up from the first number, also with 1. on every line", () => {
    expect(parseMarkdown("1. a\n1. b\n1. c").map((b) => b.marker)).toEqual(["1.", "2.", "3."])
    expect(parseMarkdown("3) a\n4) b").map((b) => b.marker)).toEqual(["3.", "4."])
    // A blank line between items keeps the count.
    expect(parseMarkdown("1. a\n\n2. b").map((b) => b.marker)).toEqual(["1.", "2."])
    // A nested list has its own count; the outer one goes on after it.
    expect(parseMarkdown("1. a\n   1. x\n   2. y\n2. b").map((b) => b.marker)).toEqual(["1.", "1.", "2.", "2."])
  })

  test("an item's indented second line joins it; a plain line ends the list", () => {
    const bs = parseMarkdown("- Valid on UPI\n  payments only\nAfter the list")
    expect(kinds(bs)).toEqual(["li", "p"])
    expect(text(bs[0])).toBe("Valid on UPI\npayments only")
    // A new list after a paragraph starts at its own number.
    expect(parseMarkdown("1. a\n\nText\n\n1. b").map((b) => b.marker)).toEqual(["1.", "", "1."])
  })

  test("inside a paragraph only 1. starts a numbered list; a bullet always does", () => {
    expect(kinds(parseMarkdown("Valid till\n2023. Then"))).toEqual(["p"])
    expect(kinds(parseMarkdown("Steps:\n1. a"))).toEqual(["p", "li"])
    expect(kinds(parseMarkdown("Terms:\n- a"))).toEqual(["p", "li"])
  })

  test("quotes join their lines; inline marks work inside", () => {
    const bs = parseMarkdown("> Best **deal**\n> this week\n\nAfter")
    expect(kinds(bs)).toEqual(["quote", "p"])
    expect(bs[0].runs).toEqual([{ text: "Best " }, { text: "deal", bold: true }, { text: "\nthis week" }])
  })

  test("lines: ---, ***, - - -", () => {
    expect(kinds(parseMarkdown("a\n\n---\n\n***\n- - -"))).toEqual(["p", "hr", "hr", "hr"])
  })

  test("code blocks keep text as written, with no inline marks", () => {
    const bs = parseMarkdown("```\n**not bold**\n  two\n```\nafter")
    expect(kinds(bs)).toEqual(["code", "p"])
    expect(bs[0].runs).toEqual([{ text: "**not bold**\n  two", code: true }])
    // Not closed: runs to the end.
    expect(parseMarkdown("~~~\nx")[0].runs).toEqual([{ text: "x", code: true }])
  })

  test("CRLF, tabs, empty and odd input", () => {
    expect(kinds(parseMarkdown("a\r\n\r\n- b"))).toEqual(["p", "li"])
    expect(parseMarkdown("")).toEqual([])
    expect(parseMarkdown("   \n\n  ")).toEqual([])
    expect(parseMarkdown(undefined as unknown as string)).toEqual([])
    expect(parseMarkdown(42 as unknown as string)).toEqual([])
  })

  test("limits: characters and blocks", () => {
    expect(parseMarkdown("a\n\nb\n\nc", { maxBlocks: 2 }).length).toBe(2)
    expect(text(parseMarkdown("abcdef", { maxChars: 3 })[0])).toBe("abc")
  })

  test("a ZeroBill offer text", () => {
    const md = [
      "## How it works",
      "Pay with **any UPI app** at the store and get *5% back*.",
      "",
      "- Min bill **₹199**",
      "- Max cashback ~~₹200~~ **₹250**",
      "",
      "Read the [full terms](https://example.com/terms).",
    ].join("\n")
    const bs = parseMarkdown(md)
    expect(kinds(bs)).toEqual(["h", "p", "li", "li", "p"])
    expect(bs[4].runs[1]).toEqual({ text: "full terms", href: "https://example.com/terms" })
  })
})

describe("speed", () => {
  test("broken text full of delimiters stays fast (no quadratic search)", () => {
    const junk = "*_[`~<(".repeat(3000) // 21000 characters, cut to 20000
    const t0 = performance.now()
    const bs = parseMarkdown(junk)
    const ms = performance.now() - t0
    expect(bs.length).toBe(1)
    expect(ms).toBeLessThan(500)
  })

  test("a long normal text parses in a few ms", () => {
    const para = "Get **₹400** back on *every* bill at [Ravi Stores](https://x.in). Use `ZB4K2Q`.\n\n"
    const md = para.repeat(150)
    const t0 = performance.now()
    const bs = parseMarkdown(md)
    expect(bs.length).toBe(150)
    expect(performance.now() - t0).toBeLessThan(200)
  })
})
