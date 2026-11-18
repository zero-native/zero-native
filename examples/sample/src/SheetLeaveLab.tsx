// Sheets whose node leaves the tree while they are open (review finding 4, zn ca3734d, 2026-11-18): each must go with
// its node, and no onDismiss is sent for a node that is gone. Open with: zn://sample/dev/sheet-leave
// - A payment-style sheet (dismissible false, as ZeroBill's checkout) whose screen is closed, replaced or reset, or
//   whose JS hangs (the error screen takes the screen's place) 1 s after the tap.
// - A sheet inside {cond && ...} whose cond turns false while it is open.
// - A sheet removed a few ms after it starts to open (the present's completion closes it).
// Log lines start with "SLAB" (the console).
import { Column, Pressable, Scroll, Sheet, Text } from "@zero-native/ui"
import { nav, signal } from "@zero-native/core"
import { c } from "./tokens"

const card = { padding: 14, borderRadius: 12, backgroundColor: c.white, borderWidth: 1, borderColor: c.border }
const tile = { padding: 14, borderRadius: 12, backgroundColor: "#4F46E5" }

/** Module level, so "Try again" (a fresh screen) keeps counting: one tap, one submit. */
let submits = 0

function SlabTile(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} style={tile}>
      <Text fontSize={15} fontWeight={600} color="#FFFFFF" textAlign="center">
        {props.label}
      </Text>
    </Pressable>
  )
}

function later(what: string, run: () => void) {
  console.log(`SLAB ${what} in 1 s`)
  setTimeout(run, 1000)
}

export function SheetLeaveLabScreen() {
  const pay = signal(false)
  const removable = signal(false)
  const quick = signal(false)
  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Scroll style={{ flex: 1 }}>
        <Column style={{ padding: 20, gap: 10 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            Sheets that leave the tree
          </Text>
          <Text fontSize={12} color={c.muted}>
            Each sheet must go with its node; no onDismiss for a node that is gone (lines start with SLAB).
          </Text>
          <SlabTile label="Open the payment sheet" onPress={() => pay.set(true)} />
          <SlabTile label="Open the removable sheet" onPress={() => removable.set(true)} />
          <SlabTile label="Open and remove it at once (12 to 72 ms)" onPress={() => {
            // The removal lands somewhere in the open: before the present (its screen not in the window yet), during
            // it (the completion closes it) or just after. One try every 400 ms, 4 ms later each time.
            for (let i = 0; i <= 15; i++) {
              const ms = 12 + i * 4
              setTimeout(() => {
                console.log(`SLAB quick ${ms} ms`)
                quick.set(true)
                setTimeout(() => quick.set(false), ms)
              }, i * 400)
            }
          }} />
          <Pressable onPress={() => nav.back()} style={card}>
            <Text fontSize={15} color={c.ink}>
              Back
            </Text>
          </Pressable>
        </Column>
      </Scroll>
      <Sheet visible={pay()} dismissible={false} onDismiss={() => console.log("SLAB onDismiss pay")} style={{ paddingHorizontal: 20, paddingBottom: 16, gap: 10 }}>
        <Text fontSize={16} fontWeight={700} color={c.ink}>
          Processing payment
        </Text>
        <SlabTile label="Submit" onPress={() => console.log(`SLAB submit ${++submits}`)} />
        <SlabTile label="Back in 1 s" onPress={() => later("back", () => nav.back())} />
        <SlabTile label="Replace this screen in 1 s" onPress={() => later("replace", () => nav.replace("crashLab"))} />
        <SlabTile label="Reset to Home in 1 s" onPress={() => later("reset", () => nav.reset([{ name: "home" }]))} />
        <SlabTile label="Hang JS in 1 s" onPress={() => later("hang", () => {
          let i = 0
          while (i >= 0) i = (i + 1) % 1000
        })} />
        <SlabTile label="Open a sheet over this one" onPress={() => removable.set(true)} />
        <SlabTile label="Close (JS)" onPress={() => pay.set(false)} />
      </Sheet>
      {removable() && (
        <Sheet visible onDismiss={() => console.log("SLAB onDismiss removable")} style={{ paddingHorizontal: 20, paddingBottom: 16, gap: 10 }}>
          <Text fontSize={16} fontWeight={700} color={c.ink}>
            Removable sheet
          </Text>
          <SlabTile label="Remove this sheet in 1 s" onPress={() => later("remove", () => removable.set(false))} />
        </Sheet>
      )}
      {quick() && (
        <Sheet visible onDismiss={() => console.log("SLAB onDismiss quick")} style={{ paddingHorizontal: 20, paddingBottom: 16 }}>
          <Text fontSize={16} fontWeight={700} color={c.ink}>
            Gone almost at once
          </Text>
        </Sheet>
      )}
    </Column>
  )
}
