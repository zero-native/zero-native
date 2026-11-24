// Text polish lab (route /dev/text-polish): the text and field cases fixed in the iOS polish round (2026-11-24), each
// as it looks on Android. UI tests: ios/SamplePackage/ZnSampleUITests/TextPolishTests.swift.
//
//   1. A multiline field with maxHeight stops growing there and scrolls inside; the line under it stays clear.
//   2. returnKeyType="next" moves focus to the next field (a read-only one is passed over); the keyboard stays up.
//   3. A Text in a taller box (height, minHeight) starts at the top, as on Android.
//   4. A TextField draws letterSpacing and textDecorationLine (a Text beside it for comparison).
//   5. numberOfLines={0} is no limit (React Native's meaning). On its own screen (/dev/text-polish/lines): Android's
//      BasicText throws on maxLines 0 until ZnTemplate.kt maps it, and this screen must open there.
//   6. A field on a hidden tab, or scrolled out of its Scroll, doesn't take the taps of a Pressable drawn there.
//   7. A chat composer (ZeroBill's): a multiline field, flex 1, minHeight 44, maxHeight 120, in a Row aligned to the
//      bottom; it grows a line at a time to 120 and then scrolls inside.
//   8. returnKeyType="next" in a List's rows goes on into the rows below the List's edge (Compose's LazyColumn
//      lays the next row out for the focus search).
//   9. A multiline field with maxHeight 112 in a Modal (ZeroBill's review box).
//  10. A multiline field with maxHeight 70 in a List's rows: each row is 70 + its padding tall, not its whole text.
//  11. (own screen, route textSpacingLab) letterSpacing keeps a label centred in its pill, and a spaced paragraph centred per line.
//  12. (own screen, route textSpacingLab) lineHeight: each line after the first adds lineHeight, loose (16 / 24) and tight (32 / 30).
//      Tight is a known iOS gap: SwiftUI keeps the font's own line height there (iOS FAILs it; Android should pass).
//
//   adb shell am start -a android.intent.action.VIEW -d "zn://sample/dev/text-polish" dev.zeronative.sample
//   (iOS passes over the read-only field in §2; Compose can focus a readOnly field, so Android may stop there.)
import { Column, List, Modal, Pressable, Row, Scroll, Stack, Tabs, Text, TextField } from "@zeronative/ui"
import { createRef, nav, signal, type TextFieldHandle } from "@zeronative/core"
import { c } from "./tokens"

const field = { fontSize: 16, color: c.ink, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8, backgroundColor: c.pillBg }
const say = (text: string) => console.info(`text-polish ${text}`)

function TpTitle(props: { text: string }) {
  return (
    <Text fontSize={13} fontWeight={700} color={c.ink}>
      {props.text}
    </Text>
  )
}

const listFields = Array.from({ length: 8 }, (_, i) => ({ id: `r${i + 1}` }))
const listNotes = [{ id: "n1" }, { id: "n2" }]
const sixLines = "One\nTwo\nThree\nFour\nFive\nSix"

// §11 and §12 (round 6, 2026-11-24). §11: a spaced label is as wide as before (half the spacing on each side, as
// Android), so "pill" is "pill-plain" + 5 × 6. §12: with Compose's default line height style (trimmed at the top and
// bottom), N lines are the font's height + (N - 1) × lineHeight, tight or loose: the second line adds lineHeight.
// "text-polish lineHeight tight ok|FAIL ..." and the same for loose. Tight FAILs on iOS (known gap, ZnText.swift header).
type LayoutEvent = { nativeEvent: { layout: { width: number; height: number } } }
const tpWidth = (name: string) => (e: LayoutEvent) => say(`width ${name} ${Math.round(e.nativeEvent.layout.width * 100) / 100}`)
const lhHeights = new Map<string, number>()
const lhSummary = signal("lineHeight: measuring…")
function tpHeight(name: string) {
  return (e: LayoutEvent) => {
    lhHeights.set(name, e.nativeEvent.layout.height)
    const parts: string[] = []
    for (const [kind, lh] of [["tight", 30], ["loose", 24]] as const) {
      const one = lhHeights.get(`${kind}-1`)
      const two = lhHeights.get(`${kind}-2`)
      if (one === undefined || two === undefined) return
      const ok = Math.abs(two - one - lh) <= 1
      parts.push(`${kind} ${ok ? "ok" : "FAIL"} 1 line ${Math.round(one * 10) / 10}, 2 lines ${Math.round(two * 10) / 10} (+${lh} wanted)`)
    }
    for (const p of parts) say(`lineHeight ${p}`)
    lhSummary.set(parts.join("; "))
  }
}

export function TextPolishLabScreen() {
  const note = signal("One\nTwo\nThree\nFour\nFive\nSix\nSeven\nEight")
  const focus = signal("none")
  const submits = signal(0)
  const tab = signal(0)
  const bigTaps = signal(0)
  const payTaps = signal(0)
  const chat = signal("")
  const review = signal("")
  const reviewOpen = signal(false)
  const gRef = createRef<TextFieldHandle>()
  const gFocuses = signal(0)
  const focused = (name: string) => {
    focus.set(name)
    say(`focus ${name}`)
  }

  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Row style={{ gap: 8, alignItems: "center", paddingHorizontal: 16, paddingVertical: 10 }}>
        <Pressable onPress={() => nav.back()} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>
        <Text testID="tp-title" fontSize={18} fontWeight={700} color={c.ink}>
          Text polish
        </Text>
      </Row>
      <Scroll style={{ flex: 1, paddingHorizontal: 16, paddingBottom: 24, gap: 14 }}>
        {/* 6. Tabs: a field at the top of tab A; tab B has a big Pressable over the same band. */}
        <TpTitle text="6. Hidden tab / clipped field" />
        <Row style={{ gap: 8 }}>
          <Pressable testID="tp-tab-a" onPress={() => tab.set(0)} style={{ padding: 8, borderRadius: 8, backgroundColor: c.pillBg }}>
            <Text fontSize={13} color={c.ink}>Tab A (field)</Text>
          </Pressable>
          <Pressable testID="tp-tab-b" onPress={() => tab.set(1)} style={{ padding: 8, borderRadius: 8, backgroundColor: c.pillBg }}>
            <Text fontSize={13} color={c.ink}>Tab B (card)</Text>
          </Pressable>
        </Row>
        <Tabs selected={tab()} style={{ height: 130 }}>
          <Column style={{ flex: 1, gap: 8 }}>
            <TextField testID="tp-tab-field" placeholder="Search on tab A" style={{ ...field, marginTop: 20 }} />
          </Column>
          <Column style={{ flex: 1 }}>
            <Pressable
              testID="tp-big"
              onPress={() => {
                bigTaps.set((n) => n + 1)
                say(`big ${bigTaps()}`)
              }}
              style={{ height: 125, borderRadius: 12, backgroundColor: "#DBEAFE", alignItems: "center", justifyContent: "center" }}
            >
              <Text testID="tp-big-count" fontSize={14} color={c.ink}>{`big taps ${bigTaps()}`}</Text>
            </Pressable>
          </Column>
        </Tabs>
        {/* A short Scroll whose second field lies below its edge, right where the Pay Pressable under it is drawn. */}
        <Scroll testID="tp-clip-scroll" style={{ height: 60, borderRadius: 8, backgroundColor: c.white, padding: 8, gap: 8 }}>
          <TextField testID="tp-clip-a" placeholder="Shown field" style={field} />
          <TextField testID="tp-clip-b" placeholder="Clipped field" style={{ ...field, marginTop: 40 }} />
        </Scroll>
        <Pressable
          testID="tp-pay"
          onPress={() => {
            payTaps.set((n) => n + 1)
            say(`pay ${payTaps()}`)
          }}
          style={{ height: 120, borderRadius: 12, backgroundColor: "#DCFCE7", alignItems: "center", justifyContent: "center" }}
        >
          <Text testID="tp-pay-count" fontSize={14} color={c.ink}>{`pay taps ${payTaps()}`}</Text>
        </Pressable>

        <TpTitle text="1. Multiline with maxHeight 80" />
        <TextField
          testID="tp-note"
          value={note()}
          onChangeText={(t) => note.set(t)}
          multiline
          style={{ ...field, minHeight: 40, maxHeight: 80 }}
        />
        <Text testID="tp-under-note" fontSize={12} color={c.muted}>
          This line stays clear of the note above.
        </Text>

        <TpTitle text="2. returnKeyType next" />
        <TextField testID="tp-next-a" placeholder="A (next)" returnKeyType="next" onFocus={() => focused("A")} onSubmitEditing={() => submits.set((n) => n + 1)} style={field} />
        <Row style={{ gap: 8 }}>
          <TextField testID="tp-next-b" placeholder="B (next)" returnKeyType="next" onFocus={() => focused("B")} style={{ ...field, flex: 1 }} />
          <TextField testID="tp-next-ro" value="read-only" editable={false} onFocus={() => focused("RO")} style={{ ...field, flex: 1 }} />
        </Row>
        <TextField testID="tp-next-c" placeholder="C (next, multiline)" multiline returnKeyType="next" onFocus={() => focused("C")} style={field} />
        <TextField testID="tp-next-d" placeholder="D (done)" returnKeyType="done" onFocus={() => focused("D")} style={field} />
        <Text testID="tp-focus" fontSize={12} color={c.muted}>{`focus ${focus()} submits ${submits()}`}</Text>
        {/* onSubmitEditing focusing a field by its ref (ZeroBill's forms) on top of "next": JS's field wins (E → G, F
            passed over); when it is the next field anyway (F → G), G is focused once. */}
        <TextField testID="tp-jump-e" placeholder="E (next, JS focuses G)" returnKeyType="next" onFocus={() => focused("E")} onSubmitEditing={() => gRef.current?.focus()} style={field} />
        <TextField testID="tp-jump-f" placeholder="F (next, JS focuses G)" returnKeyType="next" onFocus={() => focused("F")} onSubmitEditing={() => gRef.current?.focus()} style={field} />
        <TextField
          testID="tp-jump-g"
          ref={gRef}
          placeholder="G (done)"
          onFocus={() => {
            gFocuses.set((n) => n + 1)
            focused("G")
          }}
          style={field}
        />
        <Text testID="tp-jump" fontSize={12} color={c.muted}>{`G focused ${gFocuses()}`}</Text>

        <TpTitle text="3. Text in a taller box: at the top" />
        <Row style={{ gap: 8 }}>
          <Text testID="tp-tall" fontSize={14} color={c.ink} style={{ height: 60, flex: 1, backgroundColor: "#FEF3C7" }}>
            height 60
          </Text>
          <Text fontSize={14} color={c.ink} textAlign="center" style={{ height: 60, flex: 1, backgroundColor: "#FEF3C7" }}>
            centre
          </Text>
          <Text fontSize={14} color={c.ink} style={{ minHeight: 60, flex: 1, backgroundColor: "#FEF3C7" }}>
            minHeight 60
          </Text>
        </Row>

        <TpTitle text="4. letterSpacing / decoration in a field" />
        <TextField testID="tp-spaced" value="ABC123" letterSpacing={4} fontWeight={700} style={field} />
        <Text fontSize={16} fontWeight={700} letterSpacing={4} color={c.ink} style={{ paddingHorizontal: 10 }}>
          ABC123
        </Text>
        <TextField testID="tp-underline" value="underlined" textDecorationLine="underline" style={field} />
        <TextField
          testID="tp-spaced-multi"
          value={"Spaced, centred\nand 28 high"}
          multiline
          letterSpacing={2}
          lineHeight={28}
          textAlign="center"
          style={field}
        />

        <Pressable testID="tp-open-lines" onPress={() => nav.push("textPolishLinesLab")} style={{ padding: 8, borderRadius: 8, backgroundColor: c.pillBg }}>
          <Text fontSize={13} color={c.ink}>5. numberOfLines 0 (own screen)</Text>
        </Pressable>

        <TpTitle text="7. Chat composer (maxHeight 120)" />
        <Row testID="tp-chat-row" style={{ alignItems: "flex-end", paddingHorizontal: 10, paddingVertical: 8, backgroundColor: c.white, borderRadius: 8 }}>
          <TextField
            testID="tp-chat"
            value={chat()}
            onChangeText={(t) => chat.set(t)}
            placeholder="Type your message here..."
            multiline
            maxLength={1000}
            fontSize={15}
            color={c.ink}
            style={{ flex: 1, minHeight: 44, maxHeight: 120, borderRadius: 22, paddingHorizontal: 16, paddingTop: 11, paddingBottom: 11, backgroundColor: c.pillBg, marginEnd: 8 }}
          />
          <Pressable testID="tp-chat-send" onPress={() => say(`chat send ${chat().split("\n").length} lines`)} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: "#2563EB", alignItems: "center", justifyContent: "center" }}>
            <Text fontSize={16} color={c.white}>↑</Text>
          </Pressable>
        </Row>

        <TpTitle text="8. next in a List (rows below its edge)" />
        <List
          testID="tp-list"
          data={listFields}
          key={(r) => r.id}
          style={{ height: 150, borderRadius: 8, backgroundColor: c.white }}
          row={(r) => (
            <Column style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
              <TextField testID="tp-row" placeholder={`Row ${r.id} (next)`} returnKeyType="next" onFocus={() => focused(r.id)} style={field} />
            </Column>
          )}
        />

        <TpTitle text="10. Multiline (maxHeight 70) in List rows" />
        <List
          data={listNotes}
          key={(r) => r.id}
          style={{ height: 200, borderRadius: 8, backgroundColor: c.white }}
          row={(_r) => (
            <Column style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
              <TextField testID="tp-row-note" value={sixLines} multiline style={{ ...field, maxHeight: 70 }} />
            </Column>
          )}
        />
        <Text testID="tp-under-list-notes" fontSize={12} color={c.muted}>Each row above is about 78 pt tall.</Text>

        <TpTitle text="9. Multiline in a Modal (maxHeight 112)" />
        <Pressable testID="tp-open-review" onPress={() => reviewOpen.set(true)} style={{ padding: 8, borderRadius: 8, backgroundColor: c.pillBg }}>
          <Text fontSize={13} color={c.ink}>Open the review box</Text>
        </Pressable>
      </Scroll>
      <Modal visible={reviewOpen()} transparent animationType="fade" onRequestClose={() => reviewOpen.set(false)}>
        <Column justifyContent="flex-end" style={{ flex: 1, backgroundColor: "#00000080" }}>
          <Column style={{ backgroundColor: c.white, padding: 16, gap: 12, borderTopLeftRadius: 16, borderTopRightRadius: 16 }}>
            <Text fontSize={16} fontWeight={700} color={c.ink}>Review</Text>
            <TextField
              testID="tp-review"
              value={review()}
              onChangeText={(t) => review.set(t)}
              multiline
              placeholder="Tell us more"
              fontSize={15}
              color={c.ink}
              style={{ width: "100%", minHeight: 48, maxHeight: 112, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, borderWidth: 1, borderColor: "#D0D5DD" }}
            />
            <Text testID="tp-under-review" fontSize={12} color={c.muted}>This line stays under the review box.</Text>
            <Pressable testID="tp-close-review" onPress={() => reviewOpen.set(false)} style={{ padding: 10, borderRadius: 8, backgroundColor: c.pillBg, alignItems: "center" }}>
              <Text fontSize={14} color={c.ink}>Close</Text>
            </Pressable>
          </Column>
        </Column>
      </Modal>
    </Column>
  )
}

// §5 on its own screen (route textPolishLinesLab): numberOfLines={0} is no limit. Android throws here until
// ZnTemplate.kt maps 0 to no limit (BasicText takes maxLines of 1 or more).
export function TextPolishLinesLabScreen() {
  return (
    <Column style={{ flex: 1, backgroundColor: c.bg, padding: 16, gap: 14 }}>
      <Row style={{ gap: 8, alignItems: "center" }}>
        <Pressable onPress={() => nav.back()} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>
        <Text testID="tp-lines-title" fontSize={18} fontWeight={700} color={c.ink}>
          numberOfLines 0
        </Text>
      </Row>
      <Text testID="tp-lines0" numberOfLines={0} fontSize={14} color={c.ink} style={{ width: 200, backgroundColor: "#E0E7FF" }}>
        numberOfLines zero means no limit, so this sentence wraps over several lines.
      </Text>
    </Column>
  )
}

// §11 and §12 on their own screen (route textSpacingLab), in a Scroll so a short phone doesn't squeeze the last Texts
// (a squeezed Text reports a clipped height), and with no numberOfLines 0, so Android can open it now. Not on the main
// screen: at its end they changed its scroll range and testReturnKeyNextInList failed.
//   adb shell am start -a android.intent.action.VIEW -d "zn://sample/dev/text-polish/spacing" dev.zeronative.sample
export function TextSpacingLabScreen() {
  return (
    <Scroll style={{ flex: 1, backgroundColor: c.bg }}>
      <Column style={{ padding: 16, gap: 14 }}>
        <TpTitle text="11. letterSpacing stays centred" />
        <Row style={{ gap: 8, alignItems: "center" }}>
          <Row testID="tp-pill" justifyContent="center" style={{ width: 120, paddingVertical: 4, borderRadius: 12, backgroundColor: "#FDE68A" }}>
            <Text testID="tp-pill-text" onLayout={tpWidth("pill")} fontSize={14} fontWeight={700} letterSpacing={6} color={c.ink}>
              OFFER
            </Text>
          </Row>
          <Text onLayout={tpWidth("pill-plain")} fontSize={14} fontWeight={700} color={c.ink} style={{ backgroundColor: "#E0E7FF" }}>
            OFFER
          </Text>
        </Row>
        <Stack style={{ width: 220, backgroundColor: c.white }}>
          <Text testID="tp-spaced-centre" fontSize={15} letterSpacing={4} textAlign="center" color={c.ink} style={{ width: 220 }}>
            Spaced words wrap onto a second line here
          </Text>
          <Column style={{ position: "absolute", top: 0, bottom: 0, start: 109.5, width: 1, backgroundColor: "#EF4444" }} />
        </Stack>

        <TpTitle text="12. lineHeight: each line after the first adds lineHeight (tight: an iOS gap)" />
        <Text testID="tp-lh-tight-1" onLayout={tpHeight("tight-1")} fontSize={32} lineHeight={30} fontWeight={700} color={c.ink} style={{ backgroundColor: "#FEF3C7" }}>
          Tight
        </Text>
        <Text testID="tp-lh-tight-2" onLayout={tpHeight("tight-2")} fontSize={32} lineHeight={30} fontWeight={700} color={c.ink} style={{ backgroundColor: "#FEF3C7" }}>
          {"Tight\nheading"}
        </Text>
        <Text testID="tp-lh-loose-1" onLayout={tpHeight("loose-1")} fontSize={16} lineHeight={24} color={c.ink} style={{ backgroundColor: "#E0E7FF" }}>
          Loose
        </Text>
        <Text testID="tp-lh-loose-2" onLayout={tpHeight("loose-2")} fontSize={16} lineHeight={24} color={c.ink} style={{ backgroundColor: "#E0E7FF" }}>
          {"Loose\nlines"}
        </Text>
        <Text testID="tp-lh-summary" fontSize={12} color={c.muted}>
          {lhSummary()}
        </Text>
      </Column>
    </Scroll>
  )
}
