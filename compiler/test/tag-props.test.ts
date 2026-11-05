// compiler/src/tag-props.ts is generated from the element types in packages/ui (RN-compat sweep P0.8).
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { Component, Prop } from "@zero-native/template"
import { TAG_PROPS_PATH, tagPropsFile } from "../../tools/gen-tag-props"
import { BASE_PROPS, STYLE_KEYS, TAG_PROPS } from "../src/tag-props"

test("tag-props.ts matches the element types (run `bun run gen:tag-props` if this fails)", () => {
  expect(readFileSync(TAG_PROPS_PATH, "utf8").replace(/\r\n/g, "\n")).toBe(tagPropsFile())
}, 30_000)

test("the common elements are listed, and every style key is a registry prop or an RN name", () => {
  for (const tag of ["Column", "Row", "Box", "Stack", "Text", "Image", "Pressable", "TextField", "Scroll", "List", "Switch"]) {
    expect(TAG_PROPS[tag]).toBeDefined()
    expect(tag in Component).toBe(true)
  }
  expect(TAG_PROPS.Image.own.has("src")).toBe(true)
  expect(TAG_PROPS.Image.own.has("horizontal")).toBe(false)
  expect(BASE_PROPS.has("onLayout")).toBe(true)
  // RN names the compiler renames (rnStyleKey), reads itself (transform) or drops (iOS shadows) have no registry prop.
  const renamed = new Set(["marginLeft", "marginRight", "paddingLeft", "paddingRight", "left", "right", "flexGrow",
    "flexShrink", "flexBasis", "rowGap", "columnGap", "flexDirection", "transform", "shadowOffset", "shadowOpacity", "shadowRadius"])
  for (const k of STYLE_KEYS) expect(k in Prop || renamed.has(k)).toBe(true)
})
