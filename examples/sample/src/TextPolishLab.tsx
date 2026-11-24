// Text polish lab (route /dev/text-polish): the text and field cases fixed in the iOS polish round (2026-11-24), each
// as it looks on Android. UI tests: ios/SamplePackage/ZnSampleUITests/TextPolishTests.swift.
//
//   1. A multiline field with maxHeight stops growing there and scrolls inside; the line under it stays clear.
//   2. returnKeyType="next" moves focus to the next field (a read-only one is passed over); the keyboard stays up.
//   3. A Text in a taller box (height, minHeight) starts at the top, as on Android.
//   4. A TextField draws letterSpacing and textDecorationLine (a Text beside it for comparison).
//   5. numberOfLines={0} is no limit (React Native's meaning).
//   6. A field on a hidden tab, or scrolled out of its Scroll, doesn't take the taps of a Pressable drawn there.
//
//   adb shell am start -a android.intent.action.VIEW -d "zn://sample/dev/text-polish" dev.zeronative.sample
import { Column, Pressable, Row, Scroll, Tabs, Text, TextField } from "@zeronative/ui"
import { nav, signal } from "@zeronative/core"
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

export function TextPolishLabScreen() {
  const note = signal("One\nTwo\nThree\nFour\nFive\nSix\nSeven\nEight")
  const focus = signal("none")
  const submits = signal(0)
  const tab = signal(0)
  const bigTaps = signal(0)
  const payTaps = signal(0)
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

        <TpTitle text="5. numberOfLines={0}" />
        <Text testID="tp-lines0" numberOfLines={0} fontSize={14} color={c.ink} style={{ width: 200, backgroundColor: "#E0E7FF" }}>
          numberOfLines zero means no limit, so this sentence wraps over several lines.
        </Text>
      </Scroll>
    </Column>
  )
}
