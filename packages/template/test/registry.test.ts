import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { KOTLIN_REGISTRY_PATH, kotlinRegistry, readRegistryLock, REGISTRY_LOCK_PATH, registryLockText, SWIFT_REGISTRY_PATH, swiftRegistry } from "../../../tools/gen-registry"
import { el, event, slot, writeTemplateFile, type NodeSpec } from "../src"
import { ABSOLUTE_STRETCH_SINCE, Added, CAROUSEL_FILL_SINCE, BASE_VERSION, Prop, REGISTRY_VERSION, since, ZINDEX_ANY_SINCE } from "../src/registry"
import { registryProblems, registrySnapshot, type RegistryLock } from "../src/registry-lock"

test("the Kotlin registry is generated from the TS registry (run `bun run gen:registry` if this fails)", () => {
  expect(existsSync(KOTLIN_REGISTRY_PATH)).toBe(true)
  expect(readFileSync(KOTLIN_REGISTRY_PATH, "utf8").replace(/\r\n/g, "\n")).toBe(kotlinRegistry())
})

test("the Swift registry is generated from the TS registry (run `bun run gen:registry` if this fails)", () => {
  expect(existsSync(SWIFT_REGISTRY_PATH)).toBe(true)
  expect(readFileSync(SWIFT_REGISTRY_PATH, "utf8").replace(/\r\n/g, "\n")).toBe(swiftRegistry())
})

test("prop ids are unique", () => {
  const ids = Object.values(Prop).map((p) => p.id)
  expect(new Set(ids).size).toBe(ids.length)
})

// ---- OTA rules for registry changes (registry-lock.ts, docs/ota.md §3.2) --------------------------------------------

describe("registry changes follow the OTA rules", () => {
  const fresh = (): RegistryLock => JSON.parse(JSON.stringify(registrySnapshot()))

  test("the lock is up to date (run `bun run gen:registry` if this fails)", () => {
    expect(existsSync(REGISTRY_LOCK_PATH)).toBe(true)
    expect(readFileSync(REGISTRY_LOCK_PATH, "utf8").replace(/\r\n/g, "\n")).toBe(registryLockText())
    expect(registryProblems(readRegistryLock()!)).toEqual([])
  })

  test("something new needs a higher REGISTRY_VERSION", () => {
    const lock = fresh()
    delete lock.entries["component:Switch"] // as if Switch were added now, without raising the version
    expect(registryProblems(lock).join("\n")).toContain("component:Switch is new: raise REGISTRY_VERSION")
  })

  test("something new with since = the new REGISTRY_VERSION is fine", () => {
    const lock = fresh()
    lock.version = REGISTRY_VERSION - 1
    // The newest entries (since REGISTRY_VERSION), as if they were all added now.
    for (const [k, e] of Object.entries(lock.entries)) if (e.since === REGISTRY_VERSION) delete lock.entries[k]
    expect(registryProblems(lock)).toEqual([])
  })

  test("nothing may be removed, renumbered or retyped", () => {
    const lock = fresh()
    lock.entries["prop:gone"] = { id: 999, type: "number", since: 8 }
    lock.entries["prop:size"] = { ...lock.entries["prop:size"], id: 1 }
    lock.entries["prop:period"] = { ...lock.entries["prop:period"], type: "string" }
    const text = registryProblems(lock).join("\n")
    expect(text).toContain("prop:gone was removed")
    expect(text).toContain("prop:size: id changed 1 → 204")
    expect(text).toContain("prop:period: type changed string → number")
  })

  test("since never goes down, and a raised since must be the new version", () => {
    const lock = fresh()
    lock.entries["prop:text"] = { ...lock.entries["prop:text"], since: REGISTRY_VERSION + 1 }
    lock.version = REGISTRY_VERSION + 1
    expect(registryProblems(lock).join("\n")).toContain("prop:text: since went down")
  })
})

describe("a template file asks for the lowest registry version that has what it uses", () => {
  const header = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset).getUint16(6, true)

  test("only base things: BASE_VERSION, even when the compiler's registry is newer", () => {
    const f = writeTemplateFile([el("Column", {}, el("Text", { text: "hi", textAlign: "center" }))])
    expect(f.registry).toBe(BASE_VERSION)
    expect(header(f.bytes)).toBe(BASE_VERSION)
  })

  test("a newer component, prop, slot prop, enum value or event raises it", () => {
    const later = BASE_VERSION + 1
    const cases: Array<[keyof typeof Added, string, () => NodeSpec]> = [
      ["component", "Spinner", () => el("Spinner", {})],
      ["prop", "maxFontScale", () => el("Text", { text: "x", maxFontScale: 1.3 })],
      ["dynamic", "accessibilityLabel", () => el("Box", { accessibilityLabel: slot("label", "") })],
      ["enumValue", "pressFeedback.highlight", () => el("Pressable", { pressFeedback: "highlight" })],
      ["event", "onValueChange", () => el("Switch", { onValueChange: event("change") })],
    ]
    for (const [kind, name, make] of cases) {
      const table = Added[kind] as Record<string, number>
      table[name] = later
      try {
        const f = writeTemplateFile([el("Column", {}, make())])
        expect(`${kind} ${name}: ${f.registry}`).toBe(`${kind} ${name}: ${later}`)
        expect(header(f.bytes)).toBe(later)
      } finally {
        delete table[name]
      }
    }
    // A newer form inside a string prop's value (format "timing.motion": options after "~").
    expect(writeTemplateFile([el("Box", { animate: "95=t900e3~f0~r-1" })]).registry).toBe(since("format", "timing.motion"))
    expect(writeTemplateFile([el("Box", { enter: "0,0,12,1|t220e1~d120" })]).registry).toBe(since("format", "timing.motion"))
    expect(writeTemplateFile([el("Box", { animate: "*=t250e0" })]).registry).toBe(BASE_VERSION)
    // SVG draw data with a non-scaling stroke (a negative width) needs the version that reads it.
    const shape = (width: string) => `Z1 0 0 24 24 4 S - 1 #FF000000 1 0 1 ${width} 1 1 4 0 0 0 M0 0h4;`
    expect(writeTemplateFile([el("Svg", { svg: shape("-2") })]).registry).toBe(since("format", "svg.nonScaling"))
    expect(writeTemplateFile([el("Svg", { svg: shape("2") })]).registry).toBe(since("component", "Svg"))
    // An absolute child with both sides of a pair stretches between them only on newer apps.
    const abs = (sides: Record<string, number>) => writeTemplateFile([el("Stack", {}, el("Box", { position: "absolute", ...sides }))]).registry
    expect(abs({ top: 0, start: 0, end: 0, bottom: 0 })).toBe(ABSOLUTE_STRETCH_SINCE)
    expect(abs({ start: 4, end: 4 })).toBe(ABSOLUTE_STRETCH_SINCE)
    expect(abs({ top: 0, bottom: 8 })).toBe(ABSOLUTE_STRETCH_SINCE)
    expect(abs({ top: 8, end: 8 })).toBe(BASE_VERSION)
    // zIndex outside a Stack is drawn only by newer apps (R23); in a Stack it is as old as Stack.
    expect(writeTemplateFile([el("Column", {}, el("Box", { zIndex: 2 }))]).registry).toBe(ZINDEX_ANY_SINCE)
    expect(writeTemplateFile([el("Box", { zIndex: 2 })]).registry).toBe(ZINDEX_ANY_SINCE)
    expect(writeTemplateFile([el("Stack", {}, el("Box", { zIndex: 2 }))]).registry).toBe(BASE_VERSION)
    // A Carousel with a height shares it out to its pages only on newer apps (R35); with no height it draws as before.
    const carousel = (style: Record<string, unknown>) => writeTemplateFile([el("Carousel", { style }, el("Box", {}))]).registry
    expect(carousel({ flex: 1 })).toBe(CAROUSEL_FILL_SINCE)
    expect(carousel({ height: 240 })).toBe(CAROUSEL_FILL_SINCE)
    expect(carousel({ gap: 12, paddingHorizontal: 16 })).toBe(since("component", "Carousel"))
    // TextField autoComplete (R36).
    expect(writeTemplateFile([el("TextField", { autoComplete: "sms-otp" })]).registry).toBe(17)
    // Not using them: back to the base.
    expect(writeTemplateFile([el("Column", {}, el("Pressable", { pressFeedback: "ripple" }))]).registry).toBe(BASE_VERSION)
  })
})
