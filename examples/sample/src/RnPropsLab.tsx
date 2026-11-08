// A dev screen for RN props pack 2: React Native props, styles and components, with their RN names. Each check logs
// one "rn-props ..." line; the phone check (tools/plugin-phone/rnprops.ts) reads those lines, so keep their wording.
import { Box, Carousel, Column, Icon, Image, List, Modal, NavigationBar, Polygon, Pressable, Row, Scroll, Sheet, Shimmer, Stack, StatusBar, StyleSheet, Svg, Text, TextField, TouchableOpacity } from "@zero-native/ui"
import { Alert, createStorage, signal } from "@zero-native/core"
import { c } from "./tokens"

/** Bold parts from data, as a server's "**₹400** cashback" turned into parts (ask R21). */
const SPAN_PARTS = [
  { text: "You got ", bold: false },
  { text: "₹400", bold: true },
  { text: " cashback at ", bold: false },
  { text: "Ravi Stores", bold: true },
]

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
  const shimmerOn = signal(false)
  const overlay = signal<"" | "processing" | "cancelled">("") // one set() swaps two sheets (ZeroBill cancel)
  const sheet = signal(false) // a closing Sheet passes the next tap to the page (ZeroBill payment pass)
  // Opened by Home at start (devStart in HomeScreen): this sheet is already open then, at rest, with no slide-up.
  const devStart = createStorage("dev.start")
  const restSheet = signal(devStart.getString("sheet") === "1")
  if (restSheet()) devStart.delete("sheet")
  // animateIn={expr} (registry 22): no slide only when the sheet comes back with the restored screen.
  const restored = signal(restSheet())
  const note = signal("")
  const lightBars = signal(false)
  const spanHot = signal(false)
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
        {/* R44 (2026-11-07): an absolute child pinned on four sides stretches its children; the dot is centred. */}
        <Stack testID="r44-stack" style={{ width: "100%", height: 80, backgroundColor: "#E5E7EB", borderRadius: 12 }}>
          <Column style={{ position: "absolute", top: 8, start: 8, end: 8, bottom: 0 }}>
            <Column style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
              <Box testID="r44-dot" style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: "#4F46E5" }} />
            </Column>
          </Column>
        </Stack>
        {/* R11 (registry 20): transformOrigin "left": the bar is half width from the LEFT edge, not the middle. */}
        <Stack testID="origin-track" style={{ height: 24, backgroundColor: "#E5E7EB", borderRadius: 6 }}>
          <Box testID="origin-left" style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0, backgroundColor: "#16A34A", transformOrigin: "left", transform: [{ scaleX: 0.5 }] }} />
        </Stack>
        {/* The same with keyframes (the ZeroBill UPI tile's fill): it grows from the left edge, slowly, and holds. */}
        <Stack style={{ height: 24, backgroundColor: "#E5E7EB", borderRadius: 6 }}>
          <Box
            testID="origin-grow"
            animate={{ scaleX: { duration: 10000, keyframes: [0, 0.5, 1], repeat: "forever" } }}
            style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0, backgroundColor: "#4F46E5", transformOrigin: "left" }}
          />
        </Stack>
        {/* The UPI tile's shimmer (old Flutter app): a brand-tinted sweep inside a fill scaled from the left. Only
            after a tap: a shimmer redraws every frame, and uiautomator then waits ~8 s for each dump (phone steps). */}
        <HoldTile label={shimmerOn() ? "Hide shimmer fill" : "Show shimmer fill"} onPress={() => shimmerOn.set(!shimmerOn())} />
        {shimmerOn() && (
          <Stack style={{ height: 56, backgroundColor: "#FFFFFF", borderRadius: 12 }}>
            <Box
              testID="shimmer-fill"
              style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0, transformOrigin: "left", transform: [{ scaleX: 0.6 }] }}
            >
              <Shimmer baseColor="rgba(52,29,236,0.12)" highlightColor="rgba(52,29,236,0.28)" period={1000} style={{ width: "100%", height: "100%" }} />
            </Box>
          </Stack>
        )}
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

        {/* 2026-11-05, from the ZeroBill port: the last row scrolls above the floating button (contentContainerStyle),
            and a styled Column in a Stack is full width (a Stack stretches like a Column). */}
        <PropsTitle text="contentContainerStyle, Stack stretch" />
        <Stack testID="ccs-stack" style={{ height: 240 }}>
          <List
            testID="ccs-list"
            data={STICKY_ROWS.slice(1, 13)}
            key={(r) => r.id}
            contentContainerStyle={{ paddingBottom: 72 }}
            row={(r) => (
              <Stack>
                <Column style={{ paddingHorizontal: 12, paddingVertical: 12, backgroundColor: c.white }}>
                  <Text fontSize={13} color={c.ink}>
                    {r.title}
                  </Text>
                </Column>
                <Box style={{ position: "absolute", start: 0, end: 0, bottom: 0, height: 1, backgroundColor: "#E5E7EB" }} />
              </Stack>
            )}
            style={{ height: 240 }}
          />
          <Pressable
            testID="ccs-fab"
            onPress={() => say("ccs fab")}
            alignItems="center"
            style={{ position: "absolute", end: 12, bottom: 12, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 24, backgroundColor: c.primary }}
          >
            <Text fontSize={13} fontWeight={700} color={c.white}>
              Scan
            </Text>
          </Pressable>
        </Stack>

        {/* 2026-11-05, R29 / R30 from the ZeroBill port: an absolute child takes no room (the Stack is as tall as its
            text, the 220 dp shape draws over what follows), and an absolute Svg with start + end + height and
            preserveAspectRatio="none" stretches to that box. The bubble keeps its 220 dp width in a narrower Stack. */}
        <PropsTitle text="Absolute children take no room" />
        <Stack testID="abs-header">
          <Svg style={{ position: "absolute", top: 0, start: 0, end: 0, height: 120 }} viewBox="0 0 100 120" preserveAspectRatio="none">
            <Polygon points="0,0 100,0 100,80 0,120" fill="#16A34A" fillOpacity={0.3} />
          </Svg>
          <Column style={{ paddingStart: 16, paddingVertical: 12 }}>
            <Text fontSize={14} fontWeight={700} color={c.ink}>
              Stack sized by this text only
            </Text>
          </Column>
          <Box testID="abs-dot" style={{ position: "absolute", end: 8, bottom: 8, width: 12, height: 12, borderRadius: 6, backgroundColor: c.primary }} />
        </Stack>
        <Row style={{ height: 24 }} alignItems="center">
          <Text fontSize={12} color={c.ink}>
            Next row (the green shape draws over it)
          </Text>
        </Row>
        <Stack testID="abs-narrow" style={{ width: 120, height: 32, backgroundColor: "#E5E7EB" }}>
          <Column testID="abs-bubble" style={{ position: "absolute", top: 36, start: 8, width: 220, padding: 8, borderRadius: 8, backgroundColor: c.ink }}>
            <Text fontSize={12} color={c.white}>
              A 220 dp bubble from a 120 dp Stack
            </Text>
          </Column>
        </Stack>
        <Box style={{ height: 56 }} />

        {/* 2026-11-05, registry 16 from the ZeroBill port (R11 / R23 / R7, R28, R16 / R21 / R22). */}
        <PropsTitle text="Dashed lines, font padding, spans" />
        <Row gap={12} alignItems="center">
          <Box testID="dash-pill" style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, borderWidth: 1.5, borderStyle: "dashed", borderColor: c.primary }}>
            <Text fontSize={14} fontWeight={700} color={c.primary}>
              ZB4K2Q
            </Text>
          </Box>
          <Box testID="dot-box" style={{ width: 48, height: 32, borderWidth: 2, borderStyle: "dotted", borderColor: c.ink }} />
        </Row>
        <Row testID="dash-divider" style={{ paddingVertical: 8, borderBottomWidth: 1, borderStyle: "dashed", borderColor: "#9CA3AF" }}>
          <Text fontSize={13} color={c.ink}>
            Row with a dashed bottom line
          </Text>
        </Row>
        <Row gap={16}>
          <Text testID="fee-label" fontSize={14} color={c.ink} style={{ textDecorationLine: "underline", textDecorationStyle: "dashed" }}>
            Platform Fee
          </Text>
          <Text fontSize={14} color={c.ink} style={{ textDecorationLine: "line-through", textDecorationStyle: "dotted" }}>
            ₹499
          </Text>
        </Row>
        <Row gap={12} alignItems="flex-start">
          <Text testID="pad-off" fontSize={14} color={c.ink} style={{ backgroundColor: "#E5E7EB" }}>
            No font padding
          </Text>
          <Text testID="pad-on" fontSize={14} color={c.ink} style={{ backgroundColor: "#E5E7EB", includeFontPadding: true }}>
            includeFontPadding
          </Text>
        </Row>
        <Text testID="span-terms" fontSize={13} color={c.ink}>
          By continuing you agree to{" "}
          <Text style={{ color: c.primary, textDecorationLine: "underline" }} onPress={() => say("span terms")}>
            Terms
          </Text>{" "}
          and{" "}
          <Text style={{ color: c.primary, textDecorationLine: "underline" }} onPress={() => say("span privacy")}>
            Privacy
          </Text>
          .
        </Text>
        <Text testID="span-bold" fontSize={13} color={c.ink}>
          {SPAN_PARTS.map((p, i) => (
            <Text key={i} style={p.bold ? { fontWeight: "bold", color: spanHot() ? "#B91B1B" : "#047857" } : null}>
              {p.text}
            </Text>
          ))}
          {spanHot() && <Text style={{ fontStyle: "italic" }}> (changed)</Text>}
        </Text>
        <HoldTile label="Change the span colour" onPress={() => spanHot.set(!spanHot())} />

        {/* R23 part 2: a tooltip in an earlier row draws over the later rows when that row has zIndex (as in RN). */}
        <Column testID="z-rows" style={{ backgroundColor: c.white, borderRadius: 8 }}>
          <Row testID="z-row1" style={{ zIndex: 10, paddingHorizontal: 12, paddingVertical: 10 }}>
            <Stack>
              <Text fontSize={13} color={c.ink} style={{ textDecorationLine: "underline", textDecorationStyle: "dashed" }}>
                Platform Fee
              </Text>
              <Column testID="z-bubble" style={{ position: "absolute", top: 26, start: 0, width: 200, padding: 8, borderRadius: 8, backgroundColor: c.ink }}>
                <Text fontSize={12} color={c.white}>
                  Bubble from row 1, over row 2
                </Text>
              </Column>
            </Stack>
          </Row>
          <Row testID="z-row2" style={{ paddingHorizontal: 12, paddingVertical: 10, backgroundColor: "#FEF3C7" }}>
            <Text fontSize={13} color={c.ink}>
              Paid amount ₹499
            </Text>
          </Row>
        </Column>

        {/* R35: a carousel with a height (here flex: 1 in a 260 dp box) gives each page the full height, so a page's
            justifyContent works, and the dots sit at the bottom. With no height it stays as tall as its pages. */}
        <PropsTitle text="Carousel with a height" />
        <Column testID="carousel-box" style={{ height: 260, backgroundColor: "#EEF2FF", borderRadius: 12 }}>
          <Carousel testID="carousel-fill" dots style={{ flex: 1, paddingBottom: 12 }}>
            {["Scan any QR", "Pay with UPI", "Get your receipt"].map((t) => (
              <Column key={t} justifyContent="center" alignItems="center" style={{ flex: 1, width: "100%" }}>
                <Text fontSize={18} fontWeight={700} color={c.ink}>
                  {t}
                </Text>
              </Column>
            ))}
          </Carousel>
        </Column>

        <PropsTitle text="Modal" />
        <HoldTile label="Open dialog modal" onPress={() => dialog.set(true)} />
        <HoldTile label="Open page modal" onPress={() => page.set(true)} />
        {/* A Sheet over the page: after "Continue", the very next tap on the page counts, even under the sheet still
            sliding down (ZeroBill: the first keypad tap after closing the offers sheet was lost). */}
        <HoldTile label="Open offers sheet" onPress={() => sheet.set(true)} />
        <HoldTile label="Page tap" onPress={() => say("page tap")} />
        <Sheet visible={sheet()} onDismiss={() => say("sheet dismissed")} style={{ paddingHorizontal: 20, paddingBottom: 16, gap: 12 }}>
          <Text fontSize={16} fontWeight={700} color={c.ink}>
            2 offers on this store
          </Text>
          <HoldTile label="Continue to checkout" onPress={() => sheet.set(false)} />
        </Sheet>
        {/* A payment restored after a kill: kill the app after this tile, open it again; this lab is one of the first
            screens (no slide-in) and its sheet is already up (animateIn={false}). */}
        <HoldTile
          label="Open this lab at next start"
          onPress={() => {
            devStart.set("push", "rnPropsLab")
            devStart.set("sheet", "1")
            say("next start opens the lab")
          }}
        />
        <HoldTile label="Splash waits 1.5 s at next start" onPress={() => { devStart.set("hold", "1500"); say("next start holds the splash") }} />
        <HoldTile label="Splash waits forever at next start" onPress={() => { devStart.set("hold", "never"); say("next start holds the splash") }} />
        <HoldTile label="Open restored sheet now (slides)" onPress={() => restSheet.set(true)} />
        <Sheet visible={restSheet()} animateIn={!restored()} onDismiss={() => { restSheet.set(false); restored.set(false) }} style={{ paddingHorizontal: 20, paddingBottom: 16, gap: 12 }}>
          <Text fontSize={16} fontWeight={700} color={c.ink}>
            Processing secure payment
          </Text>
          <HoldTile label="Close restored sheet" onPress={() => { restSheet.set(false); restored.set(false) }} />
        </Sheet>
        {/* ZeroBill's cancelled payment: one set() closes a sheet that can't be dismissed and opens another. The first
            must go away (Lava, 2026-11-07: it stayed at rest for good). */}
        <HoldTile label="Open processing sheet" onPress={() => overlay.set("processing")} />
        <Sheet visible={overlay() === "processing"} dismissible={false} onDismiss={() => {}} style={{ paddingHorizontal: 20, paddingBottom: 16, gap: 12 }}>
          <Text fontSize={16} fontWeight={700} color={c.ink}>
            Processing payment (swap)
          </Text>
          <HoldTile label="Answer cancelled in 1 s" onPress={() => setTimeout(() => overlay.set("cancelled"), 1000)} />
          <HoldTile label="Answer cancelled in 6 s" onPress={() => setTimeout(() => overlay.set("cancelled"), 6000)} />
          {/* As ZeroBill's: a beam that never stops, and content that changes in the same update that closes it. */}
          <Box animate={{ translateX: { duration: 1500, easing: "linear", repeat: "forever", from: -60 } }} style={{ width: 60, height: 6, borderRadius: 3, backgroundColor: "#4F46E5" }} />
          {overlay() !== "processing" && (
            <Text fontSize={14} color={c.ink}>
              Response is taking longer than usual...
            </Text>
          )}
        </Sheet>
        <Sheet visible={overlay() === "cancelled"} onDismiss={() => overlay.set("")} style={{ paddingHorizontal: 20, paddingBottom: 16, gap: 12 }}>
          <Text fontSize={16} fontWeight={700} color={c.ink}>
            Payment cancelled (swap)
          </Text>
          <HoldTile label="Okay, close cancelled" onPress={() => overlay.set("")} />
        </Sheet>

        <PropsTitle text="Text onPress & Row Touchables (registry 23)" />
        <Text
          testID="text-press-tile"
          fontSize={14}
          color={c.primary}
          fontWeight={600}
          onPress={() => say("text tapped")}
          onLongPress={() => say("text long-pressed")}
          style={{ paddingVertical: 8 }}
        >
          Tappable top-level Text (tap or long-press me)
        </Text>

        <TouchableOpacity
          testID="row-touchable-btn"
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            paddingHorizontal: 16,
            paddingVertical: 12,
            backgroundColor: c.white,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: c.border,
            height: 48,
          }}
          onPress={() => say("row touchable pressed")}
        >
          <Row style={{ alignItems: "center", gap: 8 }}>
            <Icon icon="star" color={c.primary} />
            <Text fontSize={14} fontWeight={600} color={c.ink}>
              Row Touchable with Icon
            </Text>
          </Row>
          <Text fontSize={12} color={c.muted}>
            Action
          </Text>
        </TouchableOpacity>

        <Pressable
          testID="row-pressable-wrap"
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingHorizontal: 14,
            paddingVertical: 10,
            backgroundColor: "#EEF2FF",
            borderRadius: 10,
          }}
          onPress={() => say("row pressable wrap-content tapped")}
        >
          <Icon icon="check" color="#4F46E5" />
          <Text fontSize={13} fontWeight={600} color="#4F46E5">
            Row Pressable (wrap content height)
          </Text>
        </Pressable>

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
