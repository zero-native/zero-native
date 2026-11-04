// A dev screen for RN props pack 2: React Native props, styles and components, with their RN names. Each check logs
// one "rn-props ..." line; the phone check (tools/plugin-phone/rnprops.ts) reads those lines, so keep their wording.
import { Box, Column, Image, List, Modal, NavigationBar, Pressable, Row, Scroll, Stack, StatusBar, StyleSheet, Text, TextField } from "@zero-native/ui"
import { Alert, signal } from "@zero-native/core"
import { c } from "./tokens"

function PropsTitle(props: { text: string }) {
  return (
    <Text fontSize={15} fontWeight={700} color={c.ink} style={{ marginTop: 8 }}>
      {props.text}
    </Text>
  )
}

/** A design-system style wrapper: it passes its handlers through, as ZeroBill's ZPressable does. */
function HoldTile(props: { label: string; onPress?: () => void; onLongPress?: () => void }) {
  return (
    <Pressable
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      alignItems="center"
      style={{ paddingHorizontal: 14, paddingVertical: 14, borderRadius: 10, backgroundColor: c.primary }}
    >
      <Text fontSize={13} fontWeight={600} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

/** 60 rows: headers at 0 and 20 (the sticky ones), plain rows between. */
const STICKY_ROWS = Array.from({ length: 60 }, (_, i) =>
  i === 0 ? { id: "h-today", header: true, title: "Today" }
  : i === 20 ? { id: "h-earlier", header: true, title: "Earlier" }
  : { id: `r${i}`, header: false, title: `Payment ${i}` },
)

export function RnPropsLabScreen() {
  const status = signal("ready")
  const say = (text: string) => {
    console.info(`rn-props ${text}`)
    status.set(text)
  }
  const armed = signal(false)
  const name = signal("ravi's kirana store")
  const focused = signal(false)
  const overOff = signal(false)
  const tinted = signal(false)
  const wide = signal(false)
  const dialog = signal(false)
  const page = signal(false)
  const note = signal("")
  const lightBars = signal(false)
  const barHidden = signal(false)
  const stickyAt = signal<number[]>([0, 20])

  return (
    <Scroll style={{ flex: 1, backgroundColor: c.bg }}>
      <Column gap={10} style={{ padding: 16, paddingBottom: 48 }}>
        <Text testID="rn-status" fontSize={13} color={c.ink}>
          {`status: ${status()}`}
        </Text>

        <PropsTitle text="Long press (registry 14)" />
        <HoldTile label="Hold: no long press" onPress={() => say("tile-a press")} />
        <HoldTile label="Hold: long press" onPress={() => say("tile-b press")} onLongPress={() => say("tile-b long")} />
        <HoldTile
          label={armed() ? "Hold: armed" : "Hold: not armed"}
          onPress={() => say(`tile-c press armed=${armed()}`)}
          onLongPress={armed() ? () => say("tile-c long") : undefined}
        />
        <HoldTile label="Arm / disarm" onPress={() => armed.set(!armed())} />

        <PropsTitle text="absoluteFill, textTransform, testID" />
        <Stack testID="fill-stack" style={{ height: 120, backgroundColor: "#E5E7EB", borderRadius: 12 }}>
          <Text fontSize={13} color={c.ink} style={{ padding: 12 }}>
            under the overlay
          </Text>
          <Box testID="fill-all" style={[StyleSheet.absoluteFill, { backgroundColor: "#4F46E533" }]} />
          <Box testID="fill-bar" style={{ position: "absolute", start: 16, end: 16, bottom: 8, height: 24, borderRadius: 6, backgroundColor: "#16A34A" }} />
          <Box testID="fill-side" style={{ position: "absolute", top: 8, bottom: 8, end: 8, width: 12, borderRadius: 6, backgroundColor: "#F59E0B" }} />
        </Stack>
        <Text testID="tt-upper" textTransform="uppercase" fontSize={14} color={c.ink}>
          {`pay ${name()}`}
        </Text>
        <Text testID="tt-cap" textTransform="capitalize" fontSize={14} color={c.ink}>
          {name()}
        </Text>
        <Box
          testID="ios-shadow"
          style={{ height: 40, borderRadius: 8, backgroundColor: c.white, elevation: 4, shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4 }}
        />
        <HoldTile label="Rename store" onPress={() => name.set("SHARMA SWEETS and snacks")} />

        <PropsTitle text="Corners, runtime borders" />
        <Box
          testID="corners"
          style={{ height: 64, backgroundColor: "#16A34A", borderTopLeftRadius: 24, borderTopEndRadius: 0, borderBottomRightRadius: 24, borderBottomStartRadius: 0 }}
        />
        {/* Content sits inside the border (borders take space): the inner box moves when the width changes. */}
        <Box
          testID="otp-box"
          style={{
            width: 64, height: 64, borderRadius: 12, backgroundColor: c.white,
            borderWidth: focused() ? 6 : 1, borderColor: focused() ? "#4F46E5" : "#D1D5DB",
          }}
        >
          <Box testID="otp-inner" style={{ width: 8, height: 8, backgroundColor: "#F59E0B" }} />
        </Box>
        <HoldTile label={focused() ? "OTP: focused" : "OTP: idle"} onPress={() => focused.set(!focused())} />

        <PropsTitle text="pointerEvents, hitSlop" />
        {/* Each Stack: a Pressable that fills it ("under"), and an overlay on its right half. */}
        <Stack style={{ height: 56 }}>
          <Pressable testID="pe1-under" onPress={() => say("pe1 under")} style={[StyleSheet.absoluteFill, { backgroundColor: "#E5E7EB" }]} />
          <Pressable
            testID="pe1-over"
            pointerEvents={overOff() ? "none" : "auto"}
            onPress={() => say("pe1 over")}
            style={[StyleSheet.absoluteFill, { start: 160, backgroundColor: "#664F46E5" }]}
          />
        </Stack>
        <HoldTile label={overOff() ? "Overlay: none" : "Overlay: auto"} onPress={() => overOff.set(!overOff())} />
        <Stack style={{ height: 56 }}>
          <Pressable testID="pe2-under" onPress={() => say("pe2 under")} style={[StyleSheet.absoluteFill, { backgroundColor: "#E5E7EB" }]} />
          <Box testID="pe2-boxonly" pointerEvents="box-only" style={[StyleSheet.absoluteFill, { start: 160, backgroundColor: "#66F59E0B" }]}>
            <Pressable testID="pe2-inner" onPress={() => say("pe2 inner")} style={{ width: 40, height: 40, backgroundColor: "#F59E0B" }} />
          </Box>
        </Stack>
        <Stack style={{ height: 56 }}>
          <Pressable testID="pe3-under" onPress={() => say("pe3 under")} style={[StyleSheet.absoluteFill, { backgroundColor: "#E5E7EB" }]} />
          <Box testID="pe3-boxnone" pointerEvents="box-none" style={[StyleSheet.absoluteFill, { start: 160, backgroundColor: "#6616A34A" }]}>
            <Pressable testID="pe3-inner" onPress={() => say("pe3 inner")} style={{ width: 40, height: 40, backgroundColor: "#16A34A" }} />
          </Box>
        </Stack>
        <Stack style={{ height: 56 }}>
          <Pressable testID="pe4-under" onPress={() => say("pe4 under")} style={[StyleSheet.absoluteFill, { backgroundColor: "#E5E7EB" }]} />
          {/* Not written: an absolute layer (a "busy" overlay) stops taps as in RN; a plain child in the Stack lets them through. */}
          <Box testID="pe4-flow" style={{ width: 120, height: 56, backgroundColor: "#662563EB" }} />
          <Box testID="pe4-plain" style={[StyleSheet.absoluteFill, { start: 160, backgroundColor: "#66DC2626" }]} />
        </Stack>
        {/* hitSlop over empty space (the usual icon button), then over another Pressable. */}
        <Stack style={{ height: 64, backgroundColor: "#F3F4F6" }}>
          <Pressable testID="slop-free" hitSlop={20} onPress={() => say("slop-free hit")} style={{ position: "absolute", top: 20, start: 40, width: 24, height: 24, backgroundColor: "#4F46E5" }} />
        </Stack>
        <Stack style={{ height: 64 }}>
          <Pressable testID="pe5-under" onPress={() => say("pe5 under")} style={[StyleSheet.absoluteFill, { backgroundColor: "#E5E7EB" }]} />
          <Pressable testID="slop" hitSlop={20} onPress={() => say("slop hit")} style={{ position: "absolute", top: 20, start: 40, width: 24, height: 24, backgroundColor: "#4F46E5" }} />
          <Pressable testID="noslop" onPress={() => say("noslop hit")} style={{ position: "absolute", top: 20, start: 200, width: 24, height: 24, backgroundColor: "#9CA3AF" }} />
        </Stack>

        <PropsTitle text="Image tint and events, onLayout" />
        <Row gap={12}>
          <Image
            testID="img-plain"
            src="asset:images/offer-placeholder.png"
            onLoad={(e) => say(`img load ${e.nativeEvent.source.width}x${e.nativeEvent.source.height}`)}
            onLoadEnd={() => console.info("rn-props img end")}
            style={{ width: 48, height: 48 }}
          />
          <Image testID="img-tint" src="asset:images/offer-placeholder.png" tintColor={tinted() ? "#DC2626" : "#16A34A"} style={{ width: 48, height: 48 }} />
          <Image
            testID="img-bad"
            src="asset:images/missing.png"
            onError={(e) => console.info(`rn-props img error ${e.nativeEvent.error.length > 0 ? "with message" : "empty"}`)}
            style={{ width: 48, height: 48, backgroundColor: "#E5E7EB" }}
          />
        </Row>
        <HoldTile label={tinted() ? "Tint: red" : "Tint: green"} onPress={() => tinted.set(!tinted())} />
        <Box
          testID="layout-box"
          onLayout={(e) => console.info(`rn-props layout ${e.nativeEvent.layout.width}x${e.nativeEvent.layout.height}`)}
          style={{ alignSelf: "flex-start", paddingStart: wide() ? 60 : 0, backgroundColor: "#C7D2FE" }}
        >
          <Box style={{ width: 40, height: 24, backgroundColor: "#4F46E5" }} />
        </Box>
        <HoldTile label={wide() ? "Layout: wide" : "Layout: narrow"} onPress={() => wide.set(!wide())} />

        <PropsTitle text="StatusBar, NavigationBar" />
        <StatusBar barStyle={lightBars() ? "light-content" : "dark-content"} backgroundColor={lightBars() ? "#16A34A" : undefined} hidden={barHidden()} />
        <NavigationBar barStyle={lightBars() ? "light-content" : "default"} backgroundColor={lightBars() ? "#1F2937" : undefined} />
        <HoldTile label={lightBars() ? "Bars: light on colour" : "Bars: dark, no colour"} onPress={() => lightBars.set(!lightBars())} />
        <HoldTile label={barHidden() ? "Status bar: hidden" : "Status bar: shown"} onPress={() => barHidden.set(!barHidden())} />

        <PropsTitle text="Sticky list rows" />
        <HoldTile label={stickyAt().length === 2 ? "Sticky: 0 and 20" : "Sticky: 0 only"} onPress={() => stickyAt.set(stickyAt().length === 2 ? [0] : [0, 20])} />
        <List
          testID="sticky-list"
          data={STICKY_ROWS}
          key={(r) => r.id}
          stickyHeaderIndices={stickyAt()}
          row={(r) =>
            r.header ? (
              <Box style={{ height: 40, paddingHorizontal: 12, justifyContent: "center", backgroundColor: "#E0E7FF" }}>
                <Text fontSize={13} fontWeight={700} color={c.ink}>
                  {r.title}
                </Text>
              </Box>
            ) : (
              <Box style={{ height: 44, paddingHorizontal: 12, justifyContent: "center", backgroundColor: c.white }}>
                <Text fontSize={13} color={c.ink}>
                  {r.title}
                </Text>
              </Box>
            )
          }
          style={{ height: 320 }}
        />

        <PropsTitle text="Modal" />
        <HoldTile label="Open dialog modal" onPress={() => dialog.set(true)} />
        <HoldTile label="Open page modal" onPress={() => page.set(true)} />
        {/* A centred dialog with the app's own look: transparent, fade, the dim is the app's own Box. */}
        <Modal
          visible={dialog()}
          transparent
          animationType="fade"
          statusBarTranslucent
          onShow={() => say("modal dialog shown")}
          onRequestClose={() => {
            say("modal dialog close asked")
            dialog.set(false)
          }}
        >
          <Pressable testID="modal-dim" onPress={() => say("modal dim tap")} pressFeedback="none" justifyContent="center" alignItems="center" style={{ flex: 1, backgroundColor: "#00000080" }}>
            <Column testID="modal-card" gap={12} style={{ width: 280, padding: 20, borderRadius: 16, backgroundColor: c.white }}>
              <Text fontSize={16} fontWeight={700} color={c.ink}>
                Pay ₹120 to Ravi Stores?
              </Text>
              <TextField testID="modal-field" value={note()} onChangeText={(t) => note.set(t)} placeholder="Add a note" style={{ height: 44, paddingHorizontal: 10, borderWidth: 1, borderColor: "#D1D5DB", borderRadius: 8 }} />
              <HoldTile label="Alert from modal" onPress={() => Alert.alert("From the modal", "Shown above it.", [{ text: "OK", onPress: () => say("modal alert ok") }])} />
              <HoldTile label="Close modal" onPress={() => dialog.set(false)} />
            </Column>
          </Pressable>
        </Modal>
        {/* A full page: not transparent (white), slides up, stays clear of the bars. */}
        <Modal visible={page()} animationType="slide" onShow={() => say("modal page shown")} onRequestClose={() => say("modal page close asked (kept open)")}>
          <Column testID="modal-page" gap={12} style={{ padding: 16 }}>
            <Text testID="modal-page-title" fontSize={18} fontWeight={700} color={c.ink}>
              Full page modal
            </Text>
            <HoldTile label="Close page" onPress={() => page.set(false)} />
          </Column>
        </Modal>
      </Column>
    </Scroll>
  )
}
