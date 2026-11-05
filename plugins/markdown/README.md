# @zero-native/markdown

Server Markdown (offer details, notifications, help text) drawn as native text. Each paragraph, heading or list item
is **one native `<Text>` with spans** (bold, italic, links...); the blocks sit in a `<Column>`. No WebView, no HTML.

**JS only.** No Kotlin, no Gradle line, no `register` call. It ships in the bundle like app code, so an OTA update can
change it. It needs registry 16 (runtime text spans, zero-native `e794635` or newer APK).

## Add it

`package.json`: add `"@zero-native/markdown": "workspace:*"`. That's all.

## Use it

```tsx
import { Linking } from "@zero-native/core"
import { Markdown, MarkdownText } from "@zero-native/markdown"
import { Column, Text } from "@zero-native/ui"

// Offer detail: "About this offer".
export function AboutOffer(p: { details: string }) {
  const open = (url: string) => {
    // The app decides. Server text can hold any URL: allow only what you expect.
    if (url.startsWith("https://")) Linking.openURL(url)
  }
  return (
    <Column style={{ gap: 8 }}>
      <Text fontSize={12} fontWeight={800}>ABOUT THIS OFFER</Text>
      <Markdown text={p.details} onLinkPress={open} styles={{ link: { color: "#047857" } }} />
    </Column>
  )
}

// A notification card: inline marks only, cut at 2 lines.
export function NoteBody(p: { body: string }) {
  return <MarkdownText text={p.body} numberOfLines={2} style={{ fontSize: 13, color: "#4B5563" }} />
}
```

## What it reads

| Markdown | Shown as |
|---|---|
| Paragraphs (blank line between) | One `<Text>` each. **Lines inside a paragraph stay lines** (as ZeroBill's RN `MarkDownView`; CommonMark would join them) |
| `# H1` … `###### H6`, and `Title` over `===` / `---` | A heading `<Text>` (bigger, bold; TalkBack says "heading") |
| `**bold**`, `__bold__`, `*italic*`, `_italic_`, `***both***` | Bold / italic spans. `snake_case` and `2 * 3` stay text |
| `~~strike~~`, `<u>underline</u>` | Line-through / underline spans |
| `` `code` `` | A span with a grey background (no monospace font: spans can't change the font) |
| `[text](url)`, `[text](url "title")`, `<https://...>` | A link span: tappable only when you pass `onLinkPress` |
| `- item`, `* item`, `+ item`, `• item`; indented items (up to 4 levels) | A row: marker `•` `◦` `▪` and the item's `<Text>` |
| `1. item`, `1) item` | Numbered from the first number, then counting up (`1.` on every line gives 1, 2, 3) |
| `> quote` | A grey rounded box, italic text |
| ```` ``` ```` or `~~~` fenced code | A grey box, text as written (no marks inside) |
| `---`, `***`, `___` | A thin line |
| `a\` or two spaces at a line end, `<br>` | A line break |
| `\*`, `\_`, `\[` ... | The character itself |

**Not read, on purpose:** HTML (tags show as text, except `<u>` and `<br>`), images (`![alt](url)` shows only `alt`;
nothing is loaded from server text), tables, task lists, footnotes, bare URLs without `<>` (they stay plain text).

## Props

**`<Markdown>`**
- `text`: the Markdown. Can change at runtime (a new parse; rows and spans are made again).
- `onLinkPress(url, text)`: a tap on a link. Without it, links look like links but do nothing.
- `style`: the body text's look. **Span keys only**: `color`, `fontSize`, `fontWeight`, `fontStyle`,
  `textDecorationLine`, `letterSpacing`, `backgroundColor`. Can change at runtime.
- `styles`: one element's look on top of its default: `h1`…`h6`, `strong`, `em`, `del`, `u`, `code`, `link`, `quote`,
  `marker`. Same span keys.
- `limits`: `{ maxChars, maxBlocks }` (default 20000 and 200).

**`<MarkdownText>`**: inline marks only (block syntax `#`, `-`, `>` stays as text), one `<Text>`.
- `text`, `onLinkPress`, `style`, `styles` as above.
- `numberOfLines`: `1`, `2` or `3` (each its own template: layout is fixed at build time).

**Plain functions** (no UI): `parseMarkdown(text)` → blocks, `parseInline(text)` → runs, `markdownRows`,
`inlineSpans`, `DEFAULTS`. Use them to build your own look (for example a `<Text>` with `numberOfLines={4}`).

## Limits (know these)

- **Layout is fixed:** the space between blocks, list indents, the quote and code boxes, and line heights (21 for
  paragraphs and items, 20 for `MarkdownText`) are set at build time. Only span looks change. Body text up to about
  16 sp fits the line height. For other spacing, put `<Markdown>` in your own `Column`.
- **No `testID` on the component** (zn takes `testID` at build time only): wrap it in a `<Column testID="...">`.
- **No monospace for code:** a span can't change the font. Code is a grey background.
- **Component names are global in a zn app:** don't name your own component `Markdown` or `MarkdownText`.
- **Empty until JS runs:** spans from data are JS work, so the native skeleton has no text there.
- **Short texts:** blocks are a `.map` (up to ~100–200 blocks). A long article belongs in a `List`.
- **Link safety is the app's job:** `onLinkPress` gets the URL as written (`upi://`, `tel:`, `intent:` ... included).
  Check the scheme and host before opening anything.

## Size

About 10 KB of minified JS (3.7 KB gzip); about 27 KB of Hermes bytecode in the bundle, plus 19 small templates
(1.4 KB in `.zn.ui`). Measured 2026-11-05.

## Tests

`bun test plugins/markdown`: the parser (inline marks, blocks, odd and broken input, speed on 20000 characters of
broken text), the span styles the runtime sends to native, and a compile of `Markdown.tsx`. The sample's lab:
`zn://sample/dev/markdown` (Dev screen, "Markdown package").
