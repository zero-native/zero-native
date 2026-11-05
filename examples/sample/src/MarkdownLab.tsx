// A dev screen for @zero-native/markdown. Log lines start with "md-lab" (a phone test can read them).
import { signal } from "@zero-native/core"
import { Markdown, MarkdownText } from "@zero-native/markdown"
import { Column, Pressable, Row, Scroll, Text, type Children } from "@zero-native/ui"
import { c } from "./tokens"

// Close to a ZeroBill offer's `details` from the server (OfferDetailScreen "About this offer").
const OFFER = `## How it works
Pay with **any UPI app** at the store and get *5% back* as ZeroBill cashback.

- Min bill **₹199**
- Max cashback ~~₹200~~ **₹250** per bill
- Valid on <u>UPI payments only</u>

1. Scan the store's QR
1. Pay the bill
1. Cashback lands in **2 hours**

Read the [full terms](https://example.com/terms) or [call the store](tel:+919876543210).`

const ALL = `# Heading 1
### Heading 3

A paragraph with **bold**, *italic*, ***both***, ~~strike~~, \`code\` and an escaped \\*star\\*.
A second line in the same paragraph.

> A quote with a [link](https://example.com) inside.

- Top item
  - Under it
    - Deeper
- Back on top
  with a second line

---

\`\`\`
code block: **not bold**
  keeps spaces
\`\`\`

![shop photo](https://example.com/p.png) shows only its alt text. <b>HTML</b> stays text.
Bad link: [pay me](javascript:alert(1))`

const NOTE = "You got **₹400** cashback at **Ravi Stores**. It will show in your *wallet* within 2 hours. Tap [details](zn://sample/dev/markdown) for more."

// Offer terms as the server sends them: 10 short bullets, then numbered steps that reach "10.".
const TERMS = `### Terms & conditions
- Valid on bills of **₹199** and above
- Cashback up to **₹250** per bill
- One cashback per customer per day
- Valid only at the store shown above
- Pay with any UPI app through ZeroBill
- Cashback lands in your wallet within 2 hours
- Not valid with other offers at the same store
- Not valid on gift cards, fuel or tobacco
- ZeroBill can change or end this offer at any time without notice to customers
- [Full terms](https://example.com/terms)

1. One
2. Two
3. Three
4. Four
5. Five
6. Six
7. Seven
8. Eight
9. Nine
10. Ten: the number column fits two digits, so this text lines up with the others`

const QUOTE = `> Best deal near you this week: **5% back** at Ravi Stores.
> Ends Sunday.`

const OTHER = "**Changed text.** The rows and spans were made again from the new text."

// A tighter spacing an app might pick for a small card (all runtime padding: no new template).
const COMPACT = { blockGap: 6, itemGap: 2, headingTop: 10, headingBottom: 4, ruleGap: 8, markerWidth: 12, numberWidth: 20, indent: 12, quotePaddingX: 8, quotePaddingY: 4, codePadding: 8 }

function MdLabButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} alignItems="center" style={{ flex: 1, paddingHorizontal: 6, paddingVertical: 10, borderRadius: 8, backgroundColor: c.primary }}>
      <Text fontSize={12} fontWeight={600} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

function MdLabCard(props: { title: string; children?: Children }) {
  return (
    <Column style={{ gap: 8, padding: 16, borderRadius: 12, backgroundColor: c.white, borderWidth: 1, borderColor: c.border }}>
      <Text fontSize={11} fontWeight={800} color={c.muted} style={{ letterSpacing: 1 }}>
        {props.title}
      </Text>
      {props.children}
    </Column>
  )
}

export function MarkdownLabScreen() {
  const status = signal("tap a link")
  const changed = signal(false)
  const green = signal(false)
  const compact = signal(false)
  const say = (text: string) => {
    console.info(`md-lab ${text}`)
    status.set(text)
  }
  console.info("md-lab open")

  // The app decides: only https links and tel: open; anything else is refused and logged.
  const onLink = (url: string, text: string) => {
    const ok = /^https:\/\//i.test(url) || /^tel:/i.test(url)
    say(`${ok ? "open" : "refused"} ${url} (${text})`)
  }

  return (
    <Scroll style={{ flex: 1, backgroundColor: c.bg }}>
      <Column style={{ gap: 12, padding: 16 }}>
        <Text testID="md-status" fontSize={13} fontWeight={600} color={c.ink}>
          {status()}
        </Text>

        <MdLabCard title="ABOUT THIS OFFER">
          <Column testID="md-offer">
            <Markdown text={OFFER} onLinkPress={onLink} styles={{ link: { color: "#047857" }, strong: { color: "#111827" } }} />
          </Column>
        </MdLabCard>

        <MdLabCard title="OFFER TERMS (10 ITEMS)">
          <Column testID="md-terms">
            <Markdown text={TERMS} onLinkPress={onLink} spacing={compact() ? COMPACT : undefined} />
          </Column>
          <Row style={{ gap: 8 }}>
            <MdLabButton
              label={compact() ? "Default spacing" : "Compact spacing"}
              onPress={() => {
                compact.set(!compact())
                say(`spacing ${compact() ? "compact" : "default"}`)
              }}
            />
          </Row>
        </MdLabCard>

        <MdLabCard title="QUOTE WITH APP COLOURS">
          <Column testID="md-quote">
            <Markdown text={QUOTE} spacing={compact() ? COMPACT : undefined} colors={{ quoteBox: green() ? "#ECFDF5" : "#F3F4F6", quoteBar: green() ? "#059669" : "#D1D5DB" }} />
          </Column>
        </MdLabCard>

        <MdLabCard title="EVERY PART">
          <Column testID="md-all">
            <Markdown text={ALL} onLinkPress={onLink} />
          </Column>
        </MdLabCard>

        <MdLabCard title="NOTIFICATION (MarkdownText)">
          <Column testID="md-note-2">
            <MarkdownText text={`${NOTE} Valid on bills above **₹199** at any ZeroBill store near you.`} numberOfLines={2} onLinkPress={onLink} />
          </Column>
          <Column testID="md-note-full">
            <MarkdownText text={NOTE} onLinkPress={onLink} style={{ fontSize: 13, color: c.muted }} />
          </Column>
        </MdLabCard>

        <MdLabCard title="CHANGES AT RUNTIME">
          <Column testID="md-live">
            <Markdown
              text={changed() ? OTHER : "**First text.** Tap *Change text* below."}
              style={{ color: green() ? "#047857" : c.ink, fontSize: green() ? 16 : 14 }}
            />
          </Column>
          <Row style={{ gap: 8 }}>
            <MdLabButton
              label="Change text"
              onPress={() => {
                changed.set(!changed())
                say(`text ${changed() ? "changed" : "first"}`)
              }}
            />
            <MdLabButton
              label="Change style"
              onPress={() => {
                green.set(!green())
                say(`style ${green() ? "green 16" : "ink 14"}`)
              }}
            />
          </Row>
        </MdLabCard>

        <MdLabCard title="BROKEN TEXT">
          <Markdown text={"**not closed *also [not a link](\n`open ~~ <u>no end ___ ** **\n\n- \n1."} />
        </MdLabCard>
      </Column>
    </Scroll>
  )
}
