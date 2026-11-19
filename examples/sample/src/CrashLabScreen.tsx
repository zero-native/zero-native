// Crash lab (step 3.9): forces each kind of failure, to check on the phone that the app keeps working and that every
// error is reported. Open with: adb shell am start -a android.intent.action.VIEW -d zn://sample/dev/crash
import { Box, Column, Pressable, Row, Scroll, Text } from "@zeronative/ui"
import { launches, nav, onAppState, onCleanup, onError, signal } from "@zeronative/core"
import { Device } from "@zeronative/device-test"
import { c } from "./tokens"

// Module level: folded into the templates at build time.
const card = { padding: 14, borderRadius: 12, backgroundColor: c.white, borderWidth: 1, borderColor: c.border }

function LabRow(props: { title: string; detail: string; onRun: () => void }) {
  return (
    <Pressable onPress={props.onRun} style={card}>
      <Text fontSize={15} fontWeight={600} color={c.ink}>
        {props.title}
      </Text>
      <Text fontSize={12} color={c.muted}>
        {props.detail}
      </Text>
    </Pressable>
  )
}

function Broken(): never {
  throw new Error("Crash lab: this part of the screen throws while it is built")
}

/** Numbers and dates formatted by the cached methods vs the originals, and how long each takes. */
function intlCheck(): string {
  const n = 125000.5
  const d = new Date(Date.UTC(2026, 9, 30, 9, 5))
  const pairs: Array<[string, string]> = [
    [n.toLocaleString("en-IN"), new Intl.NumberFormat("en-IN").format(n)],
    [n.toLocaleString("en-IN", { style: "currency", currency: "INR" }), new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(n)],
    [d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }), new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata" }).format(d)],
    [d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" }), new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" }).format(d)],
  ]
  const same = pairs.filter(([a, b]) => a === b).length
  const t0 = Date.now()
  for (let i = 0; i < 1000; i++) (125000 + i).toLocaleString("en-IN")
  const ms = (Date.now() - t0) / 1000
  return `Intl: ${same}/${pairs.length} same as a fresh formatter; toLocaleString ${ms} ms per call; ${pairs[1][0]}, ${pairs[2][0]}`
}

export function CrashLabScreen() {
  const status = signal("Nothing reported yet")
  const count = signal(0)
  const showBroken = signal(false)
  onCleanup(
    onError((error, info) => {
      count.set((n) => n + 1)
      status.set(`#${count.peek()} ${info.kind} · ${info.where} · screen ${info.screen}: ${String(error).slice(0, 80)}`)
    }),
  )
  onAppState((state) => {
    console.log(`crash lab: app state ${state}`) // read on the phone with logcat (H.7)
    status.set(`App state: ${state}`)
  })

  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Row style={{ gap: 8, alignItems: "center", paddingHorizontal: 20, paddingVertical: 12 }}>
        <Pressable onPress={() => nav.back()} rippleBorderless rippleRadius={22} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>
        <Text fontSize={20} fontWeight={700} color={c.ink}>
          Crash lab
        </Text>
      </Row>
      <Text fontSize={12} color={c.ink} style={{ paddingHorizontal: 20, paddingBottom: 10 }}>
        {status()}
      </Text>
      <Scroll style={{ flex: 1 }}>
        <Column style={{ paddingHorizontal: 20, paddingBottom: 32, gap: 10 }}>
          <LabRow
            title="Open a screen that throws"
            detail="Shows the error screen; Go back works; Try again builds it again (it works the second time)"
            onRun={() => nav.push("crashScreen")}
          />
          <LabRow title="Tap that throws" detail="Reported; nothing else happens" onRun={() => {
            throw new Error("Crash lab: a tap handler threw")
          }} />
          <LabRow title="Async error nobody catches" detail="Reported as async (~100 ms for a TypeError)" onRun={async () => {
            await Promise.resolve()
            throw new TypeError("Crash lab: an async task threw")
          }} />
          <LabRow
            title="Show a part that throws"
            detail="Only that part stays empty (below this list); the rest keeps working"
            onRun={() => showBroken.set((v) => !v)}
          />
          <LabRow
            title="Endless loop (time limit)"
            detail="Stopped after the time limit (2 s release, 3 s debug); error screen here"
            onRun={() => {
              let i = 0
              while (i >= 0) i = (i + 1) % 1000
            }}
          />
          <LabRow
            title="Endless loop inside try / catch"
            detail="JS can't catch the time limit: stopped the same way"
            onRun={() => {
              for (;;) {
                try {
                  let i = 0
                  while (i >= 0) i = (i + 1) % 1000
                } catch {
                  // A loop that swallows every error must still be stopped.
                }
              }
            }}
          />
          <LabRow
            title="Busy for 1.5 s"
            detail="Under the time limit. To test: kill -STOP the process meanwhile, then -CONT; no hang is reported"
            onRun={() => {
              // Counts only time really spent here, so a frozen process doesn't shorten it.
              let busy = 0
              let last = Date.now()
              while (busy < 1500) {
                const now = Date.now()
                if (now - last < 100) busy += now - last
                last = now
              }
            }}
          />
          <LabRow
            title="Send native a node inside itself"
            detail="The renderer refuses it and reports it (kind renderer); the app keeps running"
            onRun={() => globalThis.__zn_mount(0, 999_000_001, 0, 999_000_001, 0, [])}
          />
          <LabRow
            title="Open the mock UPI app"
            detail="Debug builds. To test a link, or our icon, while another app is on top"
            onRun={() => {
              const old = launches.pending("mock-upi")
              void (old && old.status !== "waiting" ? launches.ack("mock-upi", old.id) : Promise.resolve())
                .then(() => Device.openMockUpi({ id: `lab${Date.now()}` }))
                .catch((e) => status.set(String(e)))
            }}
          />
          <LabRow
            title="Crash the app"
            detail="Debug builds. A Kotlin crash; the next start counts it against the running update"
            onRun={() => {
              Device.crash().catch((e) => status.set(String(e)))
            }}
          />
          <LabRow title="Check Intl formatting" detail="Cached toLocaleString vs a fresh formatter, and its speed" onRun={() => status.set(intlCheck())} />
          <Box style={card}>
            <Text fontSize={15} fontWeight={600} color={c.ink}>
              Screens come back after Android kills the app
            </Text>
            <Text fontSize={12} color={c.muted}>
              Open a few screens, press Home, run `adb shell am kill dev.zeronative.sample`, open the app from Recents.
              The broken screen (route restore: false) is left out.
            </Text>
          </Box>
          {showBroken() && <Broken />}
          <Text fontSize={12} color={c.muted}>
            End of list
          </Text>
        </Column>
      </Scroll>
    </Column>
  )
}

let opened = 0

/** Throws the first time it is built (and every other time after), so "Try again" shows the screen working. */
export function CrashScreen() {
  opened++
  if (opened % 2 === 1) throw new Error("Crash lab: this screen throws while it is built")
  return (
    <Column style={{ flex: 1, backgroundColor: c.bg, padding: 20, gap: 12 }}>
      <Text fontSize={20} fontWeight={700} color={c.ink}>
        It works now
      </Text>
      <Pressable onPress={() => nav.back()} style={card}>
        <Text fontSize={15} color={c.ink}>
          Go back
        </Text>
      </Pressable>
    </Column>
  )
}
