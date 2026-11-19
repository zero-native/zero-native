// Sheets and Modals whose node leaves the tree while they are open, and layers over one another (review findings 4 and
// 20, 2026-11-18): each must go with its node, alone (what is over it stays), and no onDismiss is sent for a node that
// is gone. Open with: zn://sample/dev/sheet-leave
// - A payment-style sheet (dismissible false, as ZeroBill's checkout) whose screen is closed, replaced or reset, or
//   whose JS hangs (the error screen takes the screen's place) 1 s after the tap.
// - A sheet inside {cond && ...} whose cond turns false while it is open.
// - A sheet removed a few ms after it starts to open.
// - Finding 20: the lower sheet closed while a sheet or a Modal is over it (the upper one stays), and the next screen
//   opening a sheet at once after a pop, replace or reset that left this screen's sheet open (the new one stays).
// - S5: an Alert or a share sheet shown over the sheet goes with it when JS closes the sheet; one shown in the same
//   tap that closes the sheet stays.
// Log lines start with "SLAB" (the console).
import { Column, Modal, Pressable, Scroll, Sheet, Text, TextField } from "@zeronative/ui"
import { Alert, nav, Os, signal } from "@zeronative/core"
import { c } from "./tokens"

const card = { padding: 14, borderRadius: 12, backgroundColor: c.white, borderWidth: 1, borderColor: c.border }
const tile = { padding: 14, borderRadius: 12, backgroundColor: "#4F46E5" }

/** Module level, so "Try again" (a fresh screen) keeps counting: one tap, one submit. */
let submits = 0
/** A lab screen under another one opens its removable sheet when this turns true (the pop case of finding 20). */
const openBelow = signal(false)

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

/** `opens`: this screen opens its removable sheet as soon as it is built. `depth`: how many lab screens are under it. */
export function SheetLeaveLabScreen(props: { opens?: boolean; depth?: number }) {
  const depth = props.depth ?? 0
  const pay = signal(false)
  const removable = signal(props.opens === true)
  const quick = signal(false)
  const modal = signal(false)
  if (props.opens) console.log(`SLAB screen at depth ${depth} opens its sheet at once`)
  const showRemovable = () => removable() || (depth === 0 && openBelow())
  const closeRemovable = () => {
    removable.set(false)
    if (depth === 0) openBelow.set(false)
  }
  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Scroll style={{ flex: 1 }}>
        <Column style={{ padding: 20, gap: 10 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            {depth > 0 ? `Sheets that leave the tree (${depth} below)` : "Sheets that leave the tree"}
          </Text>
          <Text fontSize={12} color={c.muted}>
            Each sheet must go with its node, alone; no onDismiss for a node that is gone (lines start with SLAB).
          </Text>
          <SlabTile label="Open the payment sheet" onPress={() => pay.set(true)} />
          <SlabTile label="Open the removable sheet" onPress={() => removable.set(true)} />
          <SlabTile label="Open and remove it at once (12 to 72 ms)" onPress={() => {
            // The removal lands somewhere in the open: before it shows, while it slides up, or just after. One try
            // every 400 ms, 4 ms later each time.
            for (let i = 0; i <= 15; i++) {
              const ms = 12 + i * 4
              setTimeout(() => {
                console.log(`SLAB quick ${ms} ms`)
                quick.set(true)
                setTimeout(() => quick.set(false), ms)
              }, i * 400)
            }
          }} />
          <SlabTile label="Push another lab screen" onPress={() => nav.push("sheetLeaveLab", { depth: depth + 1 })} />
          <Pressable onPress={() => nav.back()} style={card}>
            <Text fontSize={15} color={c.ink}>
              Back
            </Text>
          </Pressable>
        </Column>
      </Scroll>
      <Sheet visible={pay()} dismissible={false} onDismiss={() => console.log("SLAB onDismiss pay")} style={{ paddingHorizontal: 20, paddingBottom: 16, gap: 8 }}>
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
        <SlabTile label="Open a Modal over this one" onPress={() => modal.set(true)} />
        <SlabTile label="Replace with a screen that opens a sheet" onPress={() => {
          console.log("SLAB replace with a screen that opens a sheet")
          nav.replace("sheetLeaveLab", { opens: true, depth })
        }} />
        <SlabTile label="Reset to a screen that opens a sheet" onPress={() => {
          console.log("SLAB reset to a screen that opens a sheet")
          nav.reset([{ name: "home" }, { name: "sheetLeaveLab", params: { opens: true } }])
        }} />
        {depth > 0 && (
          <SlabTile label="Back: the screen below opens a sheet" onPress={() => {
            console.log("SLAB back, the screen below opens a sheet")
            nav.back()
            openBelow.set(true)
          }} />
        )}
        <SlabTile label="Alert, JS closes this sheet in 2.5 s" onPress={() => {
          Alert.alert("Over the sheet", "JS closes the sheet under this in 2.5 s; this goes with it.")
          later("close the sheet under an Alert (2.5 s)", () => setTimeout(() => pay.set(false), 1500))
        }} />
        <SlabTile label="Share, JS closes this sheet in 2.5 s" onPress={() => {
          void Os.share({ text: "zero-native sheet lab" })
          later("close the sheet under a share sheet (2.5 s)", () => setTimeout(() => pay.set(false), 1500))
        }} />
        <SlabTile label="Close this sheet and show an Alert" onPress={() => {
          // Same turn: the Alert must stay (it is not something the sheet opened before it closed).
          pay.set(false)
          Alert.alert("After the sheet", "The sheet closed in the same tap; this Alert stays.")
        }} />
        <SlabTile label="Close (JS)" onPress={() => pay.set(false)} />
      </Sheet>
      {showRemovable() && (
        <Sheet visible onDismiss={() => console.log("SLAB onDismiss removable")} style={{ paddingHorizontal: 20, paddingBottom: 16, gap: 10 }}>
          <Text fontSize={16} fontWeight={700} color={c.ink}>
            Removable sheet
          </Text>
          {/* The keyboard lifts the sheet: it rests on the keyboard's top edge. */}
          <TextField placeholder="A field in the sheet" style={{ height: 48, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: c.border }} />
          <SlabTile label="Remove this sheet in 1 s" onPress={() => later("remove", closeRemovable)} />
          <SlabTile label="Close the payment sheet under this one" onPress={() => {
            console.log("SLAB close the payment sheet under the removable one")
            pay.set(false)
          }} />
        </Sheet>
      )}
      {quick() && (
        <Sheet visible onDismiss={() => console.log("SLAB onDismiss quick")} style={{ paddingHorizontal: 20, paddingBottom: 16 }}>
          <Text fontSize={16} fontWeight={700} color={c.ink}>
            Gone almost at once
          </Text>
        </Sheet>
      )}
      <Modal visible={modal()} transparent animationType="fade" onShow={() => console.log("SLAB modal shown")}>
        <Pressable pressFeedback="none" justifyContent="center" alignItems="center" style={{ flex: 1, backgroundColor: "#00000080" }}>
          <Column gap={10} style={{ width: 300, padding: 20, borderRadius: 16, backgroundColor: c.white }}>
            <Text fontSize={16} fontWeight={700} color={c.ink}>
              A Modal over the sheet
            </Text>
            <SlabTile label="Close the payment sheet under this" onPress={() => {
              console.log("SLAB close the payment sheet under the Modal")
              pay.set(false)
            }} />
            <SlabTile label="Close this Modal" onPress={() => modal.set(false)} />
          </Column>
        </Pressable>
      </Modal>
    </Column>
  )
}
