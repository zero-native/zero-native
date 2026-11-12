import { expect, test } from "bun:test"
import type { Bundle, State } from "./api"
import { whyKeep } from "./logic"

test("whyKeep: staging doesn't block a delete (the dialog kills staging first); production and a live store build do", () => {
  const s = { storeBuilds: [] } as unknown as State
  const b = (serial: number, liveOn: string[]) => ({ serial, liveOn }) as unknown as Bundle
  expect(whyKeep(s, b(3, []))).toBeNull()
  expect(whyKeep(s, b(3, ["staging"]))).toBeNull()
  expect(whyKeep(s, b(3, ["production"]))).toContain("production serves it now")
  expect(whyKeep(s, b(3, ["staging", "production"]))).toBe("production serves it now: publish another bundle there (or use the kill switch) first")
  const live = { storeBuilds: [{ builtinSerial: 3, liveAt: "2026-11-10T00:00:00Z", deleteAt: null, label: "AAB 168" }] } as unknown as State
  expect(whyKeep(live, b(3, ["staging"]))).toContain("AAB 168")
})
