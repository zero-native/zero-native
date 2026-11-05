// RN-compat fixes from docs/rn-compat-sweep.md (2026-11-05): React Native code that used to compile and then do the
// wrong thing now builds right or fails with a hint.
import { describe, expect, test } from "bun:test"
import { type NodeSpec } from "@zero-native/template"
import { compileModule } from "../src/compile"

function compile(src: string, statics: Record<string, unknown> = {}) {
  const templates: NodeSpec[] = []
  const ctx = {
    reserveTemplate: () => templates.push(null as unknown as NodeSpec) - 1,
    defineTemplate: (id: number, s: NodeSpec) => void (templates[id] = s),
  }
  const out = compileModule(src, "test.tsx", ctx, new Map(Object.entries(statics)))
  return { ...out, templates }
}

const err = (src: string, statics: Record<string, unknown> = {}) => {
  try {
    compile(src, statics)
  } catch (e) {
    return (e as Error).message
  }
  return "no error"
}

describe("P0.2: negative margin, padding and border width fail the build (second-opinions 113)", () => {
  test("a negative margin, in style, in a token or as a prop, says to use translate", () => {
    expect(err(`function A() { return <Column style={{ marginTop: -8 }} /> }`))
      .toMatch(/marginTop: -8: a negative margin isn't supported.*translateY: -8/)
    expect(err(`function A() { return <Column style={[{ padding: 4 }, { marginStart: -12 }]} /> }`))
      .toMatch(/marginStart: -12.*translateX: -12/)
    expect(err(`function A() { return <Column style={s.pull} /> }`, { s: { pull: { margin: -4 } } }))
      .toMatch(/margin: -4: a negative margin/)
    expect(err(`function A() { return <Column marginBottom={-2} /> }`)).toMatch(/marginBottom: -2/)
  })
  test("a negative padding or border width says to use 0", () => {
    expect(err(`function A() { return <Column style={{ paddingTop: -4 }} /> }`)).toMatch(/paddingTop: -4: can't be negative/)
    expect(err(`function A() { return <Scroll contentContainerStyle={{ paddingBottom: -1 }} /> }`)).toMatch(/paddingBottom: -1/)
    expect(err(`function A() { return <Box style={{ borderWidth: -1 }} /> }`)).toMatch(/borderWidth: -1: can't be negative/)
  })
  test("0, positive values and negative offsets still build", () => {
    const { templates } = compile(`function A() {
      return <Column style={{ margin: 0, marginTop: 8, padding: 0, top: -4, start: -2, transform: [{ translateY: -8 }] }} />
    }`)
    expect(templates[0]!.props).toMatchObject({ margin: 0, marginTop: 8, padding: 0, top: -4, start: -2, translateY: -8 })
  })
})

describe("P0.4: absolute and zIndex only on a child of <Stack>", () => {
  test("a known non-Stack parent fails, with the parent's name", () => {
    expect(err(`function A() { return <Column><Box style={{ position: "absolute", top: 0 }} /></Column> }`))
      .toMatch(/position: "absolute" works only on a child of <Stack>; here the parent is <Column>/)
    // Registry 16 (R23): zIndex works in Column / Row / Box / Pressable; a List row (drawn one by one) still fails.
    expect(err(`function A() { return <Row><Box style={{ zIndex: 2 }} /></Row> }`)).toBe("no error")
    expect(err(`function A() { return <Scroll><Box style={{ zIndex: 2 }} /></Scroll> }`)).toMatch(/zIndex works only.*<Scroll>/)
    // A branch and a .map row are drawn in the element around them.
    expect(err(`function A(p) { return <Column>{p.on && <Box style={{ position: "absolute" }} />}</Column> }`))
      .toMatch(/parent is <Column>/)
    expect(err(`function A(p) { return <Pressable>{p.xs.map((x) => <Box key={x} style={{ position: "absolute" }} />)}</Pressable> }`))
      .toMatch(/parent is <Pressable>/)
    // A fragment adds no parent: its children are the Column's.
    expect(err(`function A() { return <Column><><Box style={{ position: "absolute" }} /></></Column> }`)).toMatch(/parent is <Column>/)
    expect(err(`function A(p) { return <List data={p.x} key={(i) => i.id} row={(i) => <Box style={{ zIndex: 1 }} />} /> }`))
      .toMatch(/parent is <List>/)
  })
  test("in a Stack, at a component's root, and through fragments and branches in a Stack, it builds", () => {
    for (const src of [
      `function A() { return <Stack><Box style={{ position: "absolute", top: 0, zIndex: 2 }} /></Stack> }`,
      `function A() { return <Box style={{ position: "absolute", top: 0 }} /> }`,
      `function A(p) { return <Stack><>{p.on && <Box style={{ position: "absolute" }} />}</></Stack> }`,
      `function A(p) { return <Stack>{p.xs.map((x) => <Box key={x} style={{ position: "absolute", start: 4 }} />)}</Stack> }`,
      `function A() { return <Stack><Column><Text>a</Text></Column><Box style={StyleSheet.absoluteFill} /></Stack> }`,
      // Inside a Stack's child, the grandchild's parent is that child again.
      `function A() { return <Column><Stack><Box style={{ position: "absolute" }} /></Stack></Column> }`,
    ]) expect(err(src)).toBe("no error")
  })
})

describe("P0.5–P0.7: taps, horizontal List, row params", () => {
  test("a press event on anything but Pressable says to wrap it", () => {
    expect(err(`function A() { return <Text onPress={() => 1}>hi</Text> }`))
      .toMatch(/onPress works only on <Pressable>: on <Text> the tap would do nothing\. Wrap it/)
    expect(err(`function A() { return <Column onLongPress={() => 1} /> }`)).toMatch(/onLongPress works only on <Pressable>/)
    expect(err(`function A() { return <Image src="x" onPressIn={() => 1} /> }`)).toMatch(/onPressIn works only/)
    expect(err(`function A() { return <Pressable onPress={() => 1} onLongPress={() => 2}><Text>a</Text></Pressable> }`)).toBe("no error")
  })
  test("<List horizontal> points at Scroll horizontal", () => {
    expect(err(`function A(p) { return <List data={p.x} key={(i) => i.id} row={(i) => <Row/>} horizontal /> }`))
      .toMatch(/<List> is vertical only.*<Scroll horizontal>/)
  })
  test("a row that destructures item / index (FlatList's renderItem habit) fails; other fields are fine", () => {
    expect(err(`function A(p) { return <List data={p.x} key={(i) => i.id} row={({ item }) => <Text>{item.name}</Text>} /> }`))
      .toMatch(/row gets the item itself/)
    expect(err(`function A(p) { return <List data={p.x} key={(i) => i.id} row={({ item: o, index }) => <Text>{o.n}</Text>} /> }`))
      .toMatch(/row gets the item itself/)
    expect(err(`function A(p) { return <List data={p.x} key={(i) => i.id} row={({ name }) => <Text>{name}</Text>} /> }`)).toBe("no error")
  })
})

describe("P0.9: a transform whose order would matter", () => {
  test("scale or rotate before a move, and a key twice, fail", () => {
    expect(err(`function A() { return <Box style={{ transform: [{ scale: 2 }, { translateX: 10 }] }} /> }`))
      .toMatch(/translateX comes after scale\. React Native would scale the move too/)
    expect(err(`function A() { return <Box style={{ transform: [{ rotate: "45deg" }, { translateY: 4 }] }} /> }`))
      .toMatch(/translateY comes after rotate\. React Native would turn the move/)
    expect(err(`function A() { return <Box style={{ transform: [{ scaleX: 2 }, { rotate: "45deg" }] }} /> }`))
      .toMatch(/rotate comes after scaleX/)
    expect(err(`function A() { return <Box style={{ transform: [{ translateX: 10 }, { translateX: 5 }] }} /> }`))
      .toMatch(/translateX twice/)
    // Values known only at runtime count.
    expect(err(`function A(p) { return <Box style={{ transform: [{ scale: p.s() }, { translateY: p.y() }] }} /> }`))
      .toMatch(/translateY comes after scale/)
  })
  test("orders that zero-native draws the same build", () => {
    for (const t of [
      `[{ translateX: 10 }, { scale: 2 }]`,
      `[{ translateY: 4 }, { rotate: "45deg" }, { scale: 0.9 }]`,
      `[{ rotate: "45deg" }, { scale: 2 }]`,
      `[{ scale: 2 }, { rotate: "10deg" }]`, // the same scale on both axes: order doesn't matter
      `[{ scale: 1 }, { translateX: 10 }]`, // scale 1 does nothing
      `[{ translateY: open() ? 0 : 10 }, { scale: open() ? 1 : 0.94 }]`, // the sample's AnimationScreen
    ]) expect(err(`function A() { return <Box style={{ transform: ${t} }} /> }`)).toBe("no error")
  })
})

// ---- P1: React Native names ----------------------------------------------------------------------------------------

const UI = `import { View, FlatList, TouchableOpacity, TouchableHighlight, TouchableWithoutFeedback, ActivityIndicator } from "@zero-native/ui"\n`
const props = (src: string, statics: Record<string, unknown> = {}) => compile(UI + src, statics).templates[0]!

describe("P1.1, P1.6, P1.12: RN style keys", () => {
  test("left / right become start / end; a start / end key beats them in either order", () => {
    expect(props(`function A() { return <Box style={{ marginLeft: 4, marginRight: 6, paddingLeft: 1, paddingRight: 2 }} /> }`).props)
      .toEqual({ marginStart: 4, marginEnd: 6, paddingStart: 1, paddingEnd: 2 })
    expect(props(`function A() { return <Box style={{ position: "absolute", left: 0, right: 8 }} /> }`).props)
      .toMatchObject({ start: 0, end: 8 })
    expect(props(`function A() { return <Box style={{ marginStart: 3, marginLeft: 9 }} /> }`).props).toEqual({ marginStart: 3 })
    expect(props(`function A() { return <Box style={[{ marginLeft: 9 }, { marginStart: 3 }]} /> }`).props).toEqual({ marginStart: 3 })
    // Runtime values work too (paddingStart can change at runtime).
    expect(props(`function A(p) { return <Box style={{ paddingLeft: p.x() }} /> }`).props)
      .toMatchObject({ paddingStart: { $slot: expect.any(String) } })
  })
  test("flexGrow is flex; flexShrink 0/1, flexBasis 0/auto and width auto are dropped", () => {
    expect(props(`function A() { return <Box style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, width: "auto" }} /> }`).props)
      .toEqual({ flex: 1 })
    expect(props(`function A() { return <Box style={{ flex: 2, flexGrow: 1 }} /> }`).props).toEqual({ flex: 2 })
    expect(props(`function A() { return <Box style={{ flexGrow: 0 }} /> }`).props).toEqual({})
    expect(err(`function A() { return <Box style={{ flexShrink: 2 }} /> }`)).toMatch(/flexShrink: only 0 or 1/)
    expect(err(`function A() { return <Box style={{ flexBasis: 100 }} /> }`)).toMatch(/flexBasis: only 0 or "auto"/)
    expect(err(`function A(p) { return <Box style={{ flexGrow: p.g() }} /> }`)).toMatch(/flexGrow must be known at build time/)
  })
  test("rowGap / columnGap give the gap along the element's own direction, and beat gap", () => {
    expect(props(`function A() { return <Column style={{ gap: 4, rowGap: 10, columnGap: 99 }} /> }`).props).toEqual({ gap: 10 })
    expect(props(`function A() { return <Row style={{ gap: 4, rowGap: 99, columnGap: 12 }} /> }`).props).toEqual({ gap: 12 })
    expect(props(`function A() { return <Row style={{ gap: 4, rowGap: 99 }} /> }`).props).toEqual({ gap: 4 })
    expect(props(`function A() { return <Scroll horizontal style={{ columnGap: 8 }} /> }`).props).toMatchObject({ gap: 8 })
    const list = props(`function A(p) { return <List data={p.x} key={(i) => i.id} row={(i) => <Row/>} style={{ rowGap: 6 }} /> }`)
    expect(list.props).toMatchObject({ gap: 6 })
  })
  test("StyleSheet.hairlineWidth, StyleSheet.flatten, aspectRatio 16/9, textAlign left / right", () => {
    expect(props(`function A() { return <Box style={{ borderTopWidth: StyleSheet.hairlineWidth }} /> }`).props).toEqual({ borderTopWidth: 0.4 })
    expect(props(`const s = StyleSheet.create({ a: { padding: 4 }, b: { padding: 8, margin: 2 } })
      function A() { return <Box style={StyleSheet.flatten([s.a, false, s.b])} /> }`).props).toEqual({ padding: 8, margin: 2 })
    expect(props(`function A() { return <Box style={{ aspectRatio: "16 / 9" }} /> }`).props.aspectRatio as number).toBeCloseTo(16 / 9)
    expect(props(`function A() { return <Text style={{ textAlign: "left" }}>a</Text> }`).props).toMatchObject({ textAlign: "start" })
    expect(props(`function A() { return <Text style={{ textAlign: "right" }}>a</Text> }`).props).toMatchObject({ textAlign: "end" })
    expect(props(`function A() { return <Text style={{ textAlign: "auto" }}>a</Text> }`).props).toMatchObject({ textAlign: "start" })
    expect(err(`function A() { return <Text style={{ textAlign: "justify" }}>a</Text> }`)).toMatch(/"justify" isn't supported/)
  })
  test("P1.3: CSS colour names and hsl()", () => {
    expect(err(`function A() { return <Box style={{ backgroundColor: "white", borderColor: "hsl(210, 50%, 40%)" }} /> }`)).toBe("no error")
    expect(err(`function A() { return <Box style={{ backgroundColor: "whiteish" }} /> }`)).toMatch(/invalid colour "whiteish"/)
  })
})

describe("P1.13: <View>", () => {
  test("a Column, or a Row from a build-time flexDirection (which is then dropped)", () => {
    expect(props(`function A() { return <View style={{ padding: 4 }} /> }`)).toMatchObject({ type: "Column", props: { padding: 4 } })
    expect(props(`function A() { return <View style={{ flexDirection: "row", gap: 8 }} /> }`)).toMatchObject({ type: "Row", props: { gap: 8 } })
    expect(props(`const s = StyleSheet.create({ row: { flexDirection: "row" } })
      function A(p) { return <View style={[s.row, { backgroundColor: p.c() }]} /> }`).type).toBe("Row")
    expect(props(`function A(p) { return <View style={{ flexDirection: "row", opacity: p.o() }} /> }`).type).toBe("Row")
    expect(err(UI + `function A(p) { return <View style={{ flexDirection: p.d() }} /> }`)).toMatch(/flexDirection on <View> must be known at build time/)
    expect(err(UI + `function A() { return <View style={{ flexDirection: "row-reverse" }} /> }`)).toMatch(/"row-reverse" isn't supported/)
    // On a zn element it stays an error, with a hint.
    expect(err(`function A() { return <Column style={{ flexDirection: "row" }} /> }`)).toMatch(/pick the element instead, <Row> or <Column>/)
  })
  test("only when imported from @zero-native/ui, and never over the app's own View", () => {
    // Not imported: a call to a component named View (the bundle then fails if there is none).
    expect(compile(`function A() { return <View /> }`).code).toContain("View(")
    const own = compile(UI + `function View() { return <Row /> }\nfunction A() { return <Column><View /></Column> }`)
    expect(own.templates.some((t) => t?.type === "Column" && t.children[0]?.type === "Anchor")).toBe(true)
  })
  test("an RN component @zero-native/ui doesn't have fails the build, as a root or a child", () => {
    const missing = `import { SafeAreaView, KeyboardAvoidingView, ScrollView, Text } from "@zero-native/ui"\n`
    expect(err(missing + `function A() { return <SafeAreaView><Text>a</Text></SafeAreaView> }`))
      .toMatch(/<SafeAreaView> is not in @zero-native\/ui: delete it and set the route option `safeArea`/)
    expect(err(missing + `function A() { return <Column><KeyboardAvoidingView /></Column> }`)).toMatch(/<KeyboardAvoidingView> is not in/)
    expect(err(missing + `function A() { return <ScrollView /> }`)).toMatch(/use <Scroll>/)
    // The app's own component of that name is fine.
    expect(compile(missing + `function SafeAreaView() { return <Column /> }\nfunction A() { return <Row><SafeAreaView /></Row> }`).code)
      .toContain("SafeAreaView")
  })
})

describe("P1.8, P1.10: Touchables, android_ripple, ActivityIndicator, Switch trackColor", () => {
  test("TouchableOpacity: no ripple, dims to activeOpacity (default 0.2)", () => {
    expect(props(`function A() { return <TouchableOpacity onPress={() => 1} /> }`).props)
      .toMatchObject({ pressFeedback: "none", pressOpacity: 0.2 })
    expect(props(`function A() { return <TouchableOpacity activeOpacity={0.7} onPress={() => 1} /> }`))
      .toMatchObject({ type: "Pressable", props: { pressFeedback: "none", pressOpacity: 0.7 } })
  })
  test("TouchableHighlight: an overlay of underlayColor at 1 - activeOpacity", () => {
    expect(props(`function A() { return <TouchableHighlight onPress={() => 1} /> }`).props)
      .toMatchObject({ pressFeedback: "highlight", highlightColor: "rgba(0, 0, 0, 0.15)" })
    expect(props(`function A() { return <TouchableHighlight underlayColor="#DDDDDD" activeOpacity={0.6} /> }`).props)
      .toMatchObject({ highlightColor: "rgba(221, 221, 221, 0.4)" })
    expect(props(`function A() { return <TouchableWithoutFeedback onPress={() => 1} /> }`).props).toMatchObject({ pressFeedback: "none" })
  })
  test("android_ripple, Switch trackColor, ActivityIndicator", () => {
    expect(props(`function A() { return <Pressable android_ripple={{ color: "#22000000", borderless: true, radius: 24, foreground: true }} /> }`).props)
      .toEqual({ rippleColor: "#22000000", rippleBorderless: true, rippleRadius: 24 })
    expect(props(`function A(p) { return <Switch value={p.on()} trackColor={{ false: "#ccc", true: "#0a0" }} ios_backgroundColor="#fff" /> }`).props)
      .toMatchObject({ trackColor: "#ccc", activeTrackColor: "#0a0" })
    expect(props(`function A() { return <ActivityIndicator size="large" color="red" /> }`))
      .toMatchObject({ type: "Spinner", props: { size: 36, color: "red" } })
    expect(props(`function A() { return <ActivityIndicator animating={false} /> }`).props).toMatchObject({ opacity: 0 })
    expect(props(`function A(p) { return <ActivityIndicator animating={p.busy()} /> }`).props)
      .toMatchObject({ opacity: { $slot: expect.any(String) } })
    expect(err(UI + `function A() { return <ActivityIndicator hidesWhenStopped={false} /> }`)).toMatch(/hidesWhenStopped=\{false\}/)
  })
})

describe("P1.4, P1.9, P1.11: Image, text, field and accessibility names", () => {
  test("Image source={{ uri }} and resizeMode", () => {
    expect(props(`function A() { return <Image source={{ uri: "https://x/a.png" }} resizeMode="stretch" /> }`).props)
      .toEqual({ src: "https://x/a.png", contentScale: "fill" })
    expect(props(`function A(p) { return <Image source={{ uri: p.url() }} /> }`).props).toMatchObject({ src: { $slot: expect.any(String) } })
    expect(err(`function A() { return <Image source={require("./a.png")} /> }`)).toMatch(/src="asset:images\/name.png"/)
    expect(err(`function A() { return <Image source={{ uri: "x", headers: {} }} /> }`)).toMatch(/only uri is supported/)
    expect(err(`function A() { return <Image src="x" resizeMode="repeat" /> }`)).toMatch(/resizeMode "repeat" isn't supported/)
  })
  test("Text and TextField", () => {
    expect(props(`function A() { return <Text allowFontScaling={false} ellipsizeMode="tail" numberOfLines={1}>a</Text> }`).props)
      .toEqual({ maxFontScale: 1, numberOfLines: 1, text: "a" })
    expect(err(`function A() { return <Text ellipsizeMode="middle">a</Text> }`)).toMatch(/always cuts the end/)
    expect(props(`function A() { return <TextField placeholderTextColor="#999" keyboardType="numeric" allowFontScaling /> }`).props)
      .toEqual({ placeholderColor: "#999", keyboardType: "decimal-pad" })
  })
  test("TextField autoComplete and textContentType (R36)", () => {
    // The RN login fields: autofill hints; textContentType is iOS only and is dropped, as RN does on Android.
    expect(props(`function A() { return <TextField autoComplete="tel-national" textContentType="telephoneNumber" /> }`).props)
      .toEqual({ autoComplete: "tel-national" })
    expect(props(`function A() { return <TextField autoComplete="sms-otp" /> }`).props).toEqual({ autoComplete: "sms-otp" })
    // RN's other names for the same hint.
    expect(props(`function A() { return <TextField autoComplete="one-time-code" /> }`).props).toEqual({ autoComplete: "sms-otp" })
    expect(props(`function A() { return <TextField autoComplete="current-password" /> }`).props).toEqual({ autoComplete: "password" })
    expect(err(`function A() { return <TextField autoComplete="cc-number" /> }`)).toMatch(/autoComplete/)
    expect(err(`function A() { return <Text autoComplete="email">a</Text> }`)).toMatch(/autoComplete/)
  })
  test("aria-label, aria-hidden, role, importantForAccessibility", () => {
    expect(props(`function A() { return <Pressable aria-label="Pay" role="button" /> }`).props)
      .toEqual({ accessibilityLabel: "Pay", accessibilityRole: "button" })
    expect(props(`function A() { return <Text role="heading">a</Text> }`).props).toMatchObject({ accessibilityRole: "header" })
    expect(props(`function A() { return <Box importantForAccessibility="no-hide-descendants" /> }`).props).toEqual({ accessibilityHidden: true })
    expect(props(`function A() { return <Box aria-hidden /> }`).props).toEqual({ accessibilityHidden: true })
    expect(err(`function A() { return <Box importantForAccessibility="no" /> }`)).toMatch(/"no" \(hide only this one\) has no match/)
    expect(err(`function A() { return <Box role="tab" /> }`)).toMatch(/role "tab" has no zero-native role/)
  })
})

describe("P1.5, P1.7: FlatList", () => {
  const listCode = (src: string) => compile(UI + src).code
  test("renderItem gets { item, index }; keyExtractor is the key", () => {
    const code = listCode(`function A(p) {
      return <FlatList data={p.x} keyExtractor={(o) => o.code} renderItem={({ item, index }) => <Text>{item.name} {index}</Text>} />
    }`)
    expect(code).toContain("key: (o) => o.code")
    expect(code).toMatch(/row: \(__znItem, __znIndex\) => \(\(\{ item, index \}\) => [\s\S]*\)\(\{ item: __znItem, index: __znIndex \}\)/)
  })
  test("no key function: RN's default (item.key, item.id, the index)", () => {
    const code = listCode(`function A(p) { return <FlatList data={p.x} renderItem={({ item }) => <Text>{item.name}</Text>} /> }`)
    expect(code).toContain("key: (__znItem, __znIndex) => (__znItem?.key ?? __znItem?.id ?? __znIndex)")
    expect(listCode(`function A(p) { return <List data={p.x} renderItem={(info) => <Text>{info.item.n}</Text>} /> }`))
      .toMatch(/row: \(__znItem, __znIndex\) => \(\(info\) => /)
  })
  test("speed hints and iOS props are dropped; errors", () => {
    const list = props(`function A(p) {
      return <FlatList data={p.x} renderItem={({ item }) => <Row/>} initialNumToRender={10} windowSize={5}
        removeClippedSubviews extraData={p.sel()} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" horizontal={false} />
    }`)
    expect(Object.keys(list.props).sort()).toEqual(["onRange"])
    expect(err(`function A(p) { return <List data={p.x} renderItem={({ item }) => <Row/>} row={(i) => <Row/>} /> }`)).toMatch(/row or renderItem, not both/)
    expect(err(`function A(p) { return <List data={p.x} renderItem={({ item, separators }) => <Row/>} /> }`)).toMatch(/only item and index/)
    expect(err(`function A() { return <Scroll showsVerticalScrollIndicator /> }`)).toMatch(/draws no scroll bar/)
    expect(err(`function A() { return <Scroll keyboardShouldPersistTaps="never" /> }`)).toMatch(/Keyboard\.dismiss\(\)/)
    expect(err(`function A(p) { return <List data={p.x} key={(i) => i.id} row={(i) => <Row/>} /> }`)).toBe("no error")
  })
})

describe("P0.8: a prop the element doesn't take fails the build", () => {
  test("props and events checked against the element's type", () => {
    expect(err(`function A() { return <Image src="x" horizontal /> }`))
      .toMatch(/horizontal isn't a prop of <Image>, so it would do nothing\. <Image>'s own props: .*src/)
    expect(err(`function A() { return <Text value="x">a</Text> }`)).toMatch(/value isn't a prop of <Text>/)
    expect(err(`function A() { return <Column numberOfLines={2} /> }`)).toMatch(/numberOfLines isn't a prop of <Column>/)
    expect(err(`function A() { return <Box src="x" /> }`)).toMatch(/src isn't a prop of <Box>/)
    expect(err(`function A() { return <Column onChangeText={() => 1} /> }`)).toMatch(/onChangeText isn't a prop of <Column>/)
    // The older, clearer messages stay.
    expect(err(`function A() { return <Box hitSlop={8} /> }`)).toMatch(/hitSlop works only on <Pressable>/)
    expect(err(`function A() { return <Text onPress={() => 1}>a</Text> }`)).toMatch(/onPress works only on <Pressable>/)
  })
  test("a style holds style keys only; text styles on a View-like element are fine (shared RN styles)", () => {
    expect(err(`function A() { return <Column style={{ src: "x" }} /> }`)).toMatch(/"src" isn't a style key/)
    expect(err(`function A(p) { return <Column style={{ horizontal: p.h }} /> }`)).toMatch(/"horizontal" isn't a style key/)
    expect(err(`function A() { return <Column style={{ color: "#000", fontSize: 12, padding: 4 }} /> }`)).toBe("no error")
  })
  test("everyday props build", () => {
    for (const src of [
      `function A(p) { return <TextField value={p.v()} onChangeText={p.set} placeholder="₹0" keyboardType="number-pad" /> }`,
      `function A(p) { return <Switch value={p.on()} onValueChange={p.set} thumbColor="#fff" /> }`,
      `function A(p) { return <Pressable onPress={p.go} pressScale={0.97} rippleColor="#fff" testID="pay" onLayout={(e) => 1}><Text>a</Text></Pressable> }`,
      `function A() { return <Image src="x" fallbackSrc="asset:images/a.png" loading="shimmer" contentScale="contain" /> }`,
      `function A() { return <Column alignItems="center" justifyContent="center" accessibilityLabel="x" impressionKey="k" /> }`,
    ]) expect(err(src)).toBe("no error")
  })
})

describe("registry 16: includeFontPadding, borderStyle, textDecorationStyle (asks R28, R11/R23/R7)", () => {
  test("written as RN style keys; kept as written for the writer", () => {
    const t = compile(`function A() { return <Text style={{ includeFontPadding: true, textDecorationLine: "underline", textDecorationStyle: "dashed" }}>Fee</Text> }`).templates[0]!
    const p = t.props as Record<string, unknown>
    expect(p.includeFontPadding).toBe(true)
    expect(p.textDecorationStyle).toBe("dashed")
    const b = compile(`function A() { return <Box style={{ borderBottomWidth: 1, borderStyle: "dotted", borderColor: "#ccc" }} /> }`).templates[0]!
    expect((b.props as Record<string, unknown>).borderStyle).toBe("dotted")
  })
  test("RN's other values fail with the list; not on a nested span", () => {
    expect(err(`function A() { return <Text style={{ textDecorationStyle: "wavy" }}>a</Text> }`)).toMatch(/solid.*dashed.*dotted/)
    expect(err(`function A() { return <Box style={{ borderStyle: "double" }} /> }`)).toMatch(/solid.*dashed.*dotted/)
    expect(err(`function A() { return <Text>a <Text style={{ textDecorationStyle: "dashed" }}>b</Text></Text> }`))
      .toMatch(/isn't supported on a nested <Text> span/)
  })
})
