import { beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { signal } from "../src/signals"
import { renderRoot, slot, textInput, view } from "../src/view"

let host: FakeHost
const ROOT = 0x80000001
const VALUE = 3 // the value slot the compiler would assign

beforeEach(() => {
  host = installFakeHost()
})

/** A screen with one controlled <TextField>; returns its onChangeText handler (wrapped as the compiler does). */
function field(handler: (amount: ReturnType<typeof signal<string>>, text: string) => void) {
  const amount = signal("")
  let onChange: (payload: string) => void = () => {}
  renderRoot(
    ROOT,
    () =>
      view(0, (inst) => {
        slot(inst, VALUE, () => amount(), 0)
        onChange = textInput(inst, VALUE, () => amount(), (t) => handler(amount, t))
      }),
    {},
  )
  host.patches.length = 0
  return { amount, change: (payload: string) => onChange(payload) }
}

test("each change gets exactly one numbered answer; the slot's own effect stays quiet", () => {
  const { change } = field((amount, t) => amount.set(t.toUpperCase()))
  change("1\u0001ab")
  expect(host.patches).toEqual([[ROOT, VALUE, "1\u0001AB"]])
})

test("a rejected change is answered with the old value, so native goes back to it", () => {
  const { amount, change } = field((a, t) => {
    if (/^\d*$/.test(t)) a.set(t)
  })
  change("1\u000112")
  change("2\u000112x")
  expect(amount()).toBe("12")
  expect(host.patches).toEqual([
    [ROOT, VALUE, "1\u000112"],
    [ROOT, VALUE, "2\u000112"],
  ])
})

test("a change from elsewhere (a Clear button) is a plain patch", () => {
  const { amount, change } = field((a, t) => a.set(t))
  change("1\u0001hello")
  host.patches.length = 0
  amount.set("")
  expect(host.patches).toEqual([[ROOT, VALUE, ""]])
})
