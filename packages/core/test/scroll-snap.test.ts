import { expect, test } from "bun:test"
import { scrollSnap } from "../src/view"

const rate = (d: unknown) => scrollSnap({ decelerationRate: d as never }).split(";").find((p) => p.startsWith("d"))

test("decelerationRate: iOS's scale as it is; fast is iOS's 0.99", () => {
  expect(rate("normal")).toBeUndefined()
  expect(rate("fast")).toBe("d0.99")
  expect(rate(0.998)).toBe("d0.998")
  expect(rate(0.97)).toBe("d0.97")
})

test("decelerationRate: a number of 0.95 or less is Android's scale, converted (0.9 stops soon, not 'normal')", () => {
  const fast = Number(rate(0.9)!.slice(1))
  expect(fast).toBeGreaterThan(0.98)
  expect(fast).toBeLessThan(0.99)
  expect(Number(rate(0.5)!.slice(1))).toBeGreaterThanOrEqual(0.91)
  expect(Number(rate(0.01)!.slice(1))).toBe(0.91) // never below what native reads as a decay
})
