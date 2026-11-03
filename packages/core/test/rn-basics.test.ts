// The RN basics pack's JS side: Platform, Dimensions, PixelRatio, Keyboard listeners, AppState, Linking, Share,
// ToastAndroid, requestAnimationFrame, a TextField ref, and flowStore's size warning.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { AppEvent } from "../src/app-events"
import { AppState, resetAppStateForTests, installAppState } from "../src/app-state"
import { installCalls } from "../src/calls"
import { Dimensions, installDimensions, PixelRatio, resetDimensionsForTests, useWindowDimensions } from "../src/dimensions"
import { installEvents } from "../src/events"
import { flowStore } from "../src/flowstore"
import { installKeyboard, Keyboard, resetKeyboardForTests, type KeyboardEvent } from "../src/keyboard"
import { Linking, Share } from "../src/linking"
import { resetNavForTests, startApp } from "../src/nav"
import { installPlatform, Platform, resetPlatformForTests } from "../src/platform"
import { defineRoutes } from "../src/routes"
import { createRoot, effect } from "../src/signals"
import { createRef, fieldRef, type TextFieldHandle } from "../src/text-field"
import { cancelAnimationFrame, installTimers, requestAnimationFrame } from "../src/timers"
import { ToastAndroid } from "../src/toast"
import { view, type Instance } from "../src/view"

let host: FakeHost
const send = (event: number, payload: unknown) => globalThis.__zn_onEvent(0, event, payload as any)
const reply = (r: object) => globalThis.__zn_onEvent(0, AppEvent.CallResult, JSON.stringify(r))
const window = (w: Record<string, number>) => send(AppEvent.Window, JSON.stringify(w))
const routes = defineRoutes({
  home: { path: "/", screen: () => view(0, () => {}) },
  offer: { path: "/offer/:id", deepLink: true, screen: (_: { id: string }) => view(0, () => {}) },
})

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
  installTimers({ replaceGlobals: false })
  resetPlatformForTests()
  resetDimensionsForTests()
  resetKeyboardForTests()
  resetAppStateForTests()
  resetNavForTests()
  installPlatform()
  installDimensions()
  installKeyboard()
})

afterEach(() => resetNavForTests())

test("Platform: OS, Version and constants come from DEVICE; select picks android", () => {
  expect(Platform.OS).toBe("android")
  expect(Platform.Version).toBe(0) // not sent yet: 0, with one warning
  expect(host.logs.filter(([level]) => level === 2)).toHaveLength(1)
  send(AppEvent.Device, JSON.stringify({ sdk: 34, release: "14", model: "Blaze 2 5G", brand: "LAVA", manufacturer: "LAVA" }))
  expect(Platform.Version).toBe(34)
  expect(Platform.constants).toEqual({ Version: 34, Release: "14", Model: "Blaze 2 5G", Brand: "LAVA", Manufacturer: "LAVA" })
  expect(Platform.select({ android: 1, ios: 2, default: 3 })).toBe(1)
  expect(Platform.select({ ios: 2, native: 4, default: 3 })).toBe(4)
  expect(Platform.select({ ios: 2, default: 3 })).toBe(3)
})

test("Dimensions and PixelRatio follow WINDOW; listeners hear changes only; reads are reactive", () => {
  const heard: number[] = []
  const seen: number[] = []
  Dimensions.addEventListener("change", ({ window }) => heard.push(window.width))
  createRoot(() => effect(() => seen.push(useWindowDimensions().width)))
  window({ width: 360, height: 800, scale: 3, fontScale: 1.3, screenWidth: 360, screenHeight: 820 })
  expect(Dimensions.get("window")).toEqual({ width: 360, height: 800, scale: 3, fontScale: 1.3 })
  expect(Dimensions.get("screen")).toEqual({ width: 360, height: 820, scale: 3, fontScale: 1.3 })
  window({ width: 360, height: 800, scale: 3, fontScale: 1.3, screenWidth: 360, screenHeight: 820 }) // same: nothing
  window({ width: 800, height: 360, scale: 3, fontScale: 1.3, screenWidth: 820, screenHeight: 360 })
  expect(heard).toEqual([360, 800])
  expect(seen).toEqual([0, 360, 800])
  expect(PixelRatio.get()).toBe(3)
  expect(PixelRatio.getFontScale()).toBe(1.3)
  expect(PixelRatio.getPixelSizeForLayoutSize(10.2)).toBe(31)
  expect(PixelRatio.roundToNearestPixel(10.2)).toBeCloseTo(31 / 3)
})

test("Dimensions listeners made in a screen stop when it closes", () => {
  const heard: number[] = []
  createRoot((dispose) => {
    Dimensions.addEventListener("change", ({ window }) => heard.push(window.width))
    dispose()
  })
  window({ width: 400, height: 800, scale: 2, fontScale: 1, screenWidth: 400, screenHeight: 800 })
  expect(heard).toEqual([])
})

test("Keyboard: show and hide events, isVisible, metrics; Will events are never sent", () => {
  window({ width: 400, height: 800, scale: 2, fontScale: 1, screenWidth: 400, screenHeight: 800 })
  const shown: KeyboardEvent[] = []
  let hidden = 0
  const sub = Keyboard.addListener("keyboardDidShow", (e) => shown.push(e))
  Keyboard.addListener("keyboardDidHide", () => hidden++)
  Keyboard.addListener("keyboardWillShow" as any, () => {
    throw new Error("never")
  })
  expect(Keyboard.isVisible()).toBe(false)
  expect(Keyboard.metrics()).toBeUndefined()
  send(AppEvent.Keyboard, JSON.stringify({ visible: true, height: 300 }))
  expect(Keyboard.isVisible()).toBe(true)
  expect(Keyboard.metrics()).toEqual({ screenX: 0, screenY: 500, width: 400, height: 300 })
  expect(shown[0].endCoordinates.height).toBe(300)
  send(AppEvent.Keyboard, JSON.stringify({ visible: true, height: 300 })) // same: nothing
  send(AppEvent.Keyboard, JSON.stringify({ visible: true, height: 340 })) // emoji panel: a new show
  send(AppEvent.Keyboard, JSON.stringify({ visible: false, height: 0 }))
  expect(shown.map((e) => e.endCoordinates.height)).toEqual([300, 340])
  expect(hidden).toBe(1)
  sub.remove()
  send(AppEvent.Keyboard, JSON.stringify({ visible: true, height: 300 }))
  expect(shown).toHaveLength(2)
})

test("Keyboard.dismiss calls the native module v2", () => {
  void Keyboard.dismiss()
  expect(host.calls.at(-1)).toMatchObject({ module: "Keyboard", method: "dismiss", args: { __v: 2 } })
})

test("AppState: currentState and change listeners on top of onAppState", () => {
  installAppState()
  const heard: string[] = []
  const sub = AppState.addEventListener("change", (s) => heard.push(s))
  send(AppEvent.AppState, "active")
  expect(AppState.currentState).toBe("active")
  send(AppEvent.AppState, "background")
  sub.remove()
  send(AppEvent.AppState, "active")
  expect(heard).toEqual(["active", "background"])
})

test("Linking.openURL and canOpenURL go to Os v2; refusals reject", async () => {
  const p = Linking.openURL("https://example.com")
  const c = host.calls.at(-1)!
  expect(c).toMatchObject({ module: "Os", method: "openUrl", args: { url: "https://example.com", __v: 2 } })
  reply({ id: c.id, ok: true, value: true })
  expect(await p).toBe(true)

  const q = Linking.openURL("whatsapp://send?text=x")
  reply({ id: host.calls.at(-1)!.id, ok: false, code: "not_allowed", error: "no" })
  expect(((await q.catch((e) => e)) as { code: string }).code).toBe("not_allowed")

  const r = Linking.canOpenURL("tel:+911234")
  expect(host.calls.at(-1)).toMatchObject({ method: "canOpenUrl", args: { url: "tel:+911234" } })
  reply({ id: host.calls.at(-1)!.id, ok: true, value: true })
  expect(await r).toBe(true)
})

test("Linking.getInitialURL waits for the start, and gives the link that opened its screen", async () => {
  startApp(routes)
  const initial = Linking.getInitialURL()
  send(AppEvent.Start, JSON.stringify([{ entry: 0x80000001, route: 1, params: { id: "5" }, link: "zn://sample/offer/5" }]))
  expect(await initial).toBe("zn://sample/offer/5")
  expect(await Linking.getInitialURL()).toBe("zn://sample/offer/5")
})

test("Linking url listeners hear links that open while the app runs, not refused ones", () => {
  let allow = true
  startApp(routes, { onLink: () => allow })
  send(AppEvent.Start, JSON.stringify([{ entry: 0x80000001, route: 0, params: {} }]))
  const heard: string[] = []
  const sub = Linking.addEventListener("url", ({ url }) => heard.push(url))
  send(AppEvent.Open, JSON.stringify({ route: 1, params: { id: "7" }, url: "zn://sample/offer/7" }))
  allow = false
  send(AppEvent.Open, JSON.stringify({ route: 1, params: { id: "8" }, url: "zn://sample/offer/8" }))
  sub.remove()
  allow = true
  send(AppEvent.Open, JSON.stringify({ route: 1, params: { id: "9" }, url: "zn://sample/offer/9" }))
  expect(heard).toEqual(["zn://sample/offer/7"])
})

test("Share.share sends message, subject and sheet title, and answers sharedAction", async () => {
  const p = Share.share({ message: "Try this", title: "Invite" }, { dialogTitle: "Share via" })
  const c = host.calls.at(-1)!
  expect(c).toMatchObject({ module: "Os", method: "share", args: { text: "Try this", subject: "Invite", dialogTitle: "Share via" } })
  reply({ id: c.id, ok: true, value: true })
  expect(await p).toEqual({ action: "sharedAction" })
  expect(Share.share({}).catch((e) => e)).resolves.toBeInstanceOf(TypeError)
})

test("ToastAndroid.show maps SHORT and LONG; gravity is ignored", () => {
  ToastAndroid.show("Saved", ToastAndroid.LONG)
  expect(host.calls.at(-1)).toMatchObject({ module: "Toast", method: "show", args: { message: "Saved", duration: "long" } })
  ToastAndroid.showWithGravity("Hi", ToastAndroid.SHORT, ToastAndroid.TOP)
  expect(host.calls.at(-1)!.args.duration).toBe("short")
})

test("requestAnimationFrame is a ~16 ms timer that gets a time; cancel stops it", () => {
  globalThis.__zn_now = () => 1234
  const times: number[] = []
  const a = requestAnimationFrame((t) => times.push(t))
  const b = requestAnimationFrame(() => times.push(-1))
  expect(host.timers.get(a)?.delay).toBe(16)
  cancelAnimationFrame(b)
  host.fire(a)
  host.fire(b)
  expect(times).toEqual([1234])
})

test("a TextField ref: focus / blur / clear call Keyboard v2; isFocused follows native; cleared when the field goes", () => {
  const ref = createRef<TextFieldHandle>()
  const inst = { id: 42 } as Instance
  let dispose = () => {}
  createRoot((d) => {
    dispose = d
    fieldRef(inst, 3, ref)
  })
  expect(ref.current).not.toBeNull()
  ref.current!.focus()
  expect(host.calls.at(-1)).toMatchObject({ module: "Keyboard", method: "focus", args: { inst: 42, id: 3, __v: 2 } })
  ref.current!.blur()
  expect(host.calls.at(-1)!.method).toBe("blur")
  ref.current!.clear()
  expect(host.calls.at(-1)!.method).toBe("clear")
  expect(ref.current!.isFocused()).toBe(false)
  globalThis.__zn_onEvent(42, 3, true)
  expect(ref.current!.isFocused()).toBe(true)
  globalThis.__zn_onEvent(42, 3, false)
  expect(ref.current!.isFocused()).toBe(false)
  dispose()
  expect(ref.current).toBeNull()
})

test("fieldRef refuses something that isn't a ref", () => {
  expect(() => createRoot(() => fieldRef({ id: 1 } as Instance, 1, (() => {}) as any))).toThrow(/createRef/)
})

test("flowStore: the limit is public; a write over 128 KB warns once per key", () => {
  globalThis.__zn_store_write = () => true
  expect(flowStore.MAX_BYTES).toBe(262128)
  const big = "x".repeat(140 * 1024)
  flowStore.write("pay", { big })
  flowStore.write("pay", { big })
  flowStore.write("small", { a: 1 })
  const warnings = host.logs.filter(([level, text]) => level === 2 && text.includes("flowStore"))
  expect(warnings).toHaveLength(1)
  expect(warnings[0][1]).toContain('"pay"')
  // Multi-byte text counts as bytes: 50,000 three-byte characters is ~150 KB.
  flowStore.write("hindi", { t: "क".repeat(50_000) })
  expect(host.logs.filter(([level, text]) => level === 2 && text.includes('"hindi"'))).toHaveLength(1)
})
