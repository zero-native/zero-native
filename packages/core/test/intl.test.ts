import { afterAll, beforeAll, expect, test } from "bun:test"
import { installIntlCache, intlOriginals } from "../src/intl"

// The cached methods must give exactly what the originals give (Bun's Intl here; the Lava's Hermes is checked on the
// sample's Crash lab screen).
let saved: typeof intlOriginals
beforeAll(() => {
  saved = { ...intlOriginals }
  installIntlCache()
})
afterAll(() => {
  Number.prototype.toLocaleString = saved.number
  Date.prototype.toLocaleString = saved.date
  Date.prototype.toLocaleDateString = saved.dateOnly
  Date.prototype.toLocaleTimeString = saved.timeOnly
})

test("numbers: same text as the original for many locales and options", () => {
  const cases: Array<[number, string | undefined, Intl.NumberFormatOptions | undefined]> = [
    [125000.5, "en-IN", undefined],
    [1250000.5, "en-IN", { style: "currency", currency: "INR" }],
    [400, "en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }],
    [1250000, "en-IN", { notation: "compact" }],
    [0.256, "en-IN", { style: "percent" }],
    [-42.1, "hi-IN", undefined],
    [1234.5678, undefined, undefined],
    [NaN, "en-IN", undefined],
  ]
  for (const [n, l, o] of cases) expect(n.toLocaleString(l, o)).toBe(saved.number.call(n, l, o))
})

test("dates: same text as the original, with each method's defaults", () => {
  const d = new Date(Date.UTC(2026, 9, 30, 9, 5, 7))
  const tz = { timeZone: "Asia/Kolkata" }
  const options: Array<Intl.DateTimeFormatOptions | undefined> = [
    tz,
    { ...tz, day: "numeric", month: "short", year: "numeric" },
    { ...tz, hour: "numeric", minute: "2-digit" },
    { ...tz, dateStyle: "medium", timeStyle: "short" },
    { ...tz, weekday: "long" },
  ]
  for (const o of options) {
    expect(d.toLocaleString("en-IN", o)).toBe(saved.date.call(d, "en-IN", o))
    if (!o?.timeStyle) expect(d.toLocaleDateString("en-IN", o)).toBe(saved.dateOnly.call(d, "en-IN", o))
    if (!o?.dateStyle) expect(d.toLocaleTimeString("en-IN", o)).toBe(saved.timeOnly.call(d, "en-IN", o))
  }
  const bad = new Date(NaN)
  expect(bad.toLocaleString("en-IN")).toBe(saved.date.call(bad, "en-IN"))
})

test("a date-only method given a time style fails as the original does", () => {
  const d = new Date(0)
  expect(() => d.toLocaleDateString("en-IN", { timeStyle: "short" })).toThrow()
})
