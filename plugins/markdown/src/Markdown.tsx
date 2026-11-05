// <Markdown> and <MarkdownText>: server Markdown drawn as native text. Each block is one native <Text> whose spans
// come from data (registry 16, guide §18); the blocks sit in a <Column>. No WebView, no HTML.
// Layout (gaps, padding, line height) is fixed here at build time; only span looks (colour, size, weight, style,
// decoration, background) and the space above a block change at runtime.
import { computed } from "@zero-native/core"
import { Box, Column, Row, Text } from "@zero-native/ui"
import type { ParseOptions } from "./parse"
import { inlineSpans, markdownRows, type DrawSpan, type MarkdownStyles, type SpanStyle } from "./render"

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
  const rows = computed(() => markdownRows(p.text, p.style, p.styles, p.limits))
  return (
    <Column>
      {rows().map((r) => (
        <Column key={r.key} style={{ paddingTop: r.top }}>
          {r.kind === "hr" ? (
            <Box style={{ height: 1, marginVertical: 4, backgroundColor: "#E5E7EB" }} />
          ) : r.kind === "li" ? (
            <Row style={{ paddingStart: r.indent, alignItems: "flex-start" }}>
              <Text style={{ minWidth: 20, paddingEnd: 6, lineHeight: 21 }}>
                <Text style={r.marker}>{r.markerText}</Text>
              </Text>
              <Text style={{ flex: 1, lineHeight: 21 }}>
                {r.spans.map((sp, i) => (
                  <Text key={i} style={sp.style} onPress={linkPress(sp, p.onLinkPress)}>
                    {sp.text}
                  </Text>
                ))}
              </Text>
            </Row>
          ) : r.kind === "quote" ? (
            <Box style={{ backgroundColor: "#F3F4F6", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 }}>
              <Text style={{ lineHeight: 21 }}>
                {r.spans.map((sp, i) => (
                  <Text key={i} style={sp.style} onPress={linkPress(sp, p.onLinkPress)}>
                    {sp.text}
                  </Text>
                ))}
              </Text>
            </Box>
          ) : r.kind === "code" ? (
            <Box style={{ backgroundColor: "#F3F4F6", borderRadius: 8, padding: 12 }}>
              <Text style={{ lineHeight: 20 }}>
                {r.spans.map((sp, i) => (
                  <Text key={i} style={sp.style}>
                    {sp.text}
                  </Text>
                ))}
              </Text>
            </Box>
          ) : r.kind === "h" ? (
            <Text accessibilityRole="header">
              {r.spans.map((sp, i) => (
                <Text key={i} style={sp.style} onPress={linkPress(sp, p.onLinkPress)}>
                  {sp.text}
                </Text>
              ))}
            </Text>
          ) : (
            <Text style={{ lineHeight: 21 }}>
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
