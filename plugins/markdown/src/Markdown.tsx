// <Markdown> and <MarkdownText>: server Markdown drawn as native text. Each block is one native <Text> whose spans
// come from data (registry 16, guide §18); the blocks sit in a <Column>. No WebView, no HTML.
// Line heights, corner radius and the quote bar's width are fixed here at build time. Span looks (colour, size,
// weight, style, decoration, background), box colours and all spacing change at runtime: every gap is per-edge
// padding on one node (a runtime prop), never `gap` or margin (build time). Default numbers are chosen for reading
// (second-opinions 142, render.ts DEFAULT_SPACING).
import { computed } from "@zero-native/core"
import { Box, Column, Row, Stack, Text } from "@zero-native/ui"
import type { ParseOptions } from "./parse"
import { DEFAULT_COLORS, inlineSpans, markdownRows, spacingOf, type DrawSpan, type MarkdownColors, type MarkdownSpacing, type MarkdownStyles, type SpanStyle } from "./render"

export interface MarkdownProps {
  /** The Markdown text, for example an offer's `details` from the server. */
  text: string
  /**
   * A tap on a link. Without it, links look like links but do nothing. The app decides what to open: check the
   * scheme and host first (server text can hold any URL).
   */
  onLinkPress?: (url: string, text: string) => void
  /** The body text's look (span keys only: color, fontSize, fontWeight, fontStyle, textDecorationLine, ...). */
  style?: SpanStyle
  /** One element's look: h1..h6, strong, em, del, u, code, link, quote, marker. */
  styles?: MarkdownStyles
  /** Box colours: quoteBox, quoteBar, codeBox, rule. Can change at runtime. */
  colors?: MarkdownColors
  /** Space around blocks (blockGap, itemGap, headingTop, ...; DEFAULT_SPACING). Can change at runtime. */
  spacing?: MarkdownSpacing
  /** Limits for very long text (default 20000 characters, 200 blocks). */
  limits?: ParseOptions
}

export interface MarkdownTextProps {
  /** Inline Markdown: **bold**, *italic*, ~~strike~~, `code`, [links](https://...). Lines stay lines. */
  text: string
  onLinkPress?: (url: string, text: string) => void
  style?: SpanStyle
  styles?: MarkdownStyles
  /** Cut to this many lines with "…". Only 1, 2 or 3 (each is its own template; layout is fixed at build time). */
  numberOfLines?: 1 | 2 | 3
}

/** A link span's press handler: only when it is a link and the app gave onLinkPress. */
function linkPress(sp: DrawSpan, onLinkPress: ((url: string, text: string) => void) | undefined): (() => void) | undefined {
  const href = sp.href
  return href !== undefined && onLinkPress ? () => onLinkPress(href, sp.text) : undefined
}

/** Paragraphs, headings, lists, quotes, code blocks and lines from Markdown text. */
export function Markdown(p: MarkdownProps) {
  const rows = computed(() => markdownRows(p.text, p.style, p.styles, p.limits, p.spacing))
  const col = computed(() => ({ ...DEFAULT_COLORS, ...p.colors }))
  const gap = computed(() => spacingOf(p.spacing))
  return (
    <Column>
      {rows().map((r) => (
        <Column key={r.key} style={{ paddingTop: r.top }}>
          {r.kind === "hr" ? (
            <Box style={{ height: 1, backgroundColor: col().rule }} />
          ) : r.kind === "li" ? (
            <Row style={{ paddingStart: r.indent, alignItems: "flex-start" }}>
              {/* The marker column: an empty box as wide as its paddingStart (width can't change at runtime, padding
                  can), with the marker drawn over it. Its own width (40) lets "10." sit in a narrow column unwrapped.
                  No height: a fixed 22 made a one-line row taller than its text (one line draws about 16.5 dp, as
                  the line height is trimmed), so the gap under a one-line item was 5.5 dp bigger than under a longer
                  one (seen on the Lava, 2026-11-05). The marker is absolute, so it takes no room and still draws. */}
              <Stack>
                <Box style={{ paddingStart: r.markerWidth }} />
                <Text style={{ position: "absolute", top: 0, start: 0, width: 40, lineHeight: 22 }}>
                  <Text style={r.marker}>{r.markerText}</Text>
                </Text>
              </Stack>
              <Text style={{ flex: 1, lineHeight: 22 }}>
                {r.spans.map((sp, i) => (
                  <Text key={i} style={sp.style} onPress={linkPress(sp, p.onLinkPress)}>
                    {sp.text}
                  </Text>
                ))}
              </Text>
            </Row>
          ) : r.kind === "quote" ? (
            // The bar is an absolute child with top + bottom, so it is as tall as the box; the box clips its corners.
            <Stack style={{ borderRadius: 8, overflow: "hidden", backgroundColor: col().quoteBox }}>
              <Box
                style={{
                  paddingStart: 3 + gap().quotePaddingX,
                  paddingEnd: gap().quotePaddingX,
                  paddingTop: gap().quotePaddingY,
                  paddingBottom: gap().quotePaddingY,
                }}
              >
                <Text style={{ lineHeight: 22 }}>
                  {r.spans.map((sp, i) => (
                    <Text key={i} style={sp.style} onPress={linkPress(sp, p.onLinkPress)}>
                      {sp.text}
                    </Text>
                  ))}
                </Text>
              </Box>
              <Box style={{ position: "absolute", top: 0, bottom: 0, start: 0, width: 3, backgroundColor: col().quoteBar }} />
            </Stack>
          ) : r.kind === "code" ? (
            <Box
              style={{
                borderRadius: 8,
                paddingStart: gap().codePadding,
                paddingEnd: gap().codePadding,
                paddingTop: gap().codePadding,
                paddingBottom: gap().codePadding,
                backgroundColor: col().codeBox,
              }}
            >
              <Text style={{ lineHeight: 20 }}>
                {r.spans.map((sp, i) => (
                  <Text key={i} style={sp.style}>
                    {sp.text}
                  </Text>
                ))}
              </Text>
            </Box>
          ) : r.kind === "h" ? (
            // One template per line height: a line height is fixed at build time.
            r.level === 1 ? (
              <Text accessibilityRole="header" style={{ lineHeight: 28 }}>
                {r.spans.map((sp, i) => (
                  <Text key={i} style={sp.style} onPress={linkPress(sp, p.onLinkPress)}>
                    {sp.text}
                  </Text>
                ))}
              </Text>
            ) : r.level === 2 ? (
              <Text accessibilityRole="header" style={{ lineHeight: 26 }}>
                {r.spans.map((sp, i) => (
                  <Text key={i} style={sp.style} onPress={linkPress(sp, p.onLinkPress)}>
                    {sp.text}
                  </Text>
                ))}
              </Text>
            ) : r.level === 3 ? (
              <Text accessibilityRole="header" style={{ lineHeight: 24 }}>
                {r.spans.map((sp, i) => (
                  <Text key={i} style={sp.style} onPress={linkPress(sp, p.onLinkPress)}>
                    {sp.text}
                  </Text>
                ))}
              </Text>
            ) : r.level === 4 ? (
              <Text accessibilityRole="header" style={{ lineHeight: 22 }}>
                {r.spans.map((sp, i) => (
                  <Text key={i} style={sp.style} onPress={linkPress(sp, p.onLinkPress)}>
                    {sp.text}
                  </Text>
                ))}
              </Text>
            ) : (
              <Text accessibilityRole="header" style={{ lineHeight: 20 }}>
                {r.spans.map((sp, i) => (
                  <Text key={i} style={sp.style} onPress={linkPress(sp, p.onLinkPress)}>
                    {sp.text}
                  </Text>
                ))}
              </Text>
            )
          ) : (
            <Text style={{ lineHeight: 22 }}>
              {r.spans.map((sp, i) => (
                <Text key={i} style={sp.style} onPress={linkPress(sp, p.onLinkPress)}>
                  {sp.text}
                </Text>
              ))}
            </Text>
          )}
        </Column>
      ))}
    </Column>
  )
}

/** Inline Markdown in one native <Text>, for a notification or a list row. Block syntax (#, -, >) stays as text. */
export function MarkdownText(p: MarkdownTextProps) {
  const spans = computed(() => inlineSpans(p.text, p.style, p.styles))
  return p.numberOfLines === 1 ? (
    <Text numberOfLines={1} style={{ lineHeight: 20 }}>
      {spans().map((sp, i) => (
        <Text key={i} style={sp.style} onPress={linkPress(sp, p.onLinkPress)}>
          {sp.text}
        </Text>
      ))}
    </Text>
  ) : p.numberOfLines === 2 ? (
    <Text numberOfLines={2} style={{ lineHeight: 20 }}>
      {spans().map((sp, i) => (
        <Text key={i} style={sp.style} onPress={linkPress(sp, p.onLinkPress)}>
          {sp.text}
        </Text>
      ))}
    </Text>
  ) : p.numberOfLines === 3 ? (
    <Text numberOfLines={3} style={{ lineHeight: 20 }}>
      {spans().map((sp, i) => (
        <Text key={i} style={sp.style} onPress={linkPress(sp, p.onLinkPress)}>
          {sp.text}
        </Text>
      ))}
    </Text>
  ) : (
    <Text style={{ lineHeight: 20 }}>
      {spans().map((sp, i) => (
        <Text key={i} style={sp.style} onPress={linkPress(sp, p.onLinkPress)}>
          {sp.text}
        </Text>
      ))}
    </Text>
  )
}
