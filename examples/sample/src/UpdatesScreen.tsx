// OTA updates (step 4.5): what runs now, what runs next, the last check, and a button to check now.
// Open with: adb shell am start -a android.intent.action.VIEW -d zn://sample/dev/updates
import { Column, Pressable, Row, Text } from "@zero-native/ui"
import { nav, signal, Updates, type UpdateStatus } from "@zero-native/core"
import { c } from "./tokens"

const card = { padding: 14, borderRadius: 12, backgroundColor: c.white, borderWidth: 1, borderColor: c.border, gap: 4 }

function describe(s: UpdateStatus): string[] {
  if (!s.enabled) return ["Updates are off (ZnOta.configure not called)"]
  const pct = s.phase === "downloading" ? ` ${Math.round(s.progress * 100)} %` : ""
  return [
    `Channel: ${s.channel}`,
    `Running now: ${s.running ?? `the APK's own (${s.builtIn})`}`,
    `Next start: ${s.next ?? `the APK's own (${s.builtIn})`}${s.pendingRestart ? "  ← restart to apply" : ""}`,
    `Phase: ${s.phase}${pct}`,
    `Last check: ${s.lastCheckAt ? new Date(s.lastCheckAt).toLocaleTimeString("en-IN") : "never"} ${s.lastResult ?? ""}`,
    ...(s.lastError ? [`Last error: ${s.lastError}`] : []),
  ]
}

export function UpdatesScreen() {
  const lines = signal<string[]>(["…"])
  const busy = signal(false)
  const show = (s: UpdateStatus) => lines.set(describe(s))
  Updates.status().then(show)
  Updates.onStatus(show)

  const checkNow = async () => {
    if (busy()) return
    busy.set(true)
    try {
      const r = await Updates.check()
      show(r.status)
      lines.set([...lines(), `Check: ${r.action} ${r.reason}${r.bundle ? ` ${r.bundle}` : ""}${r.error ? ` (${r.error})` : ""}`])
    } finally {
      busy.set(false)
    }
  }

  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Row style={{ gap: 8, alignItems: "center", paddingHorizontal: 20, paddingVertical: 12 }}>
        <Pressable onPress={() => nav.back()} rippleBorderless rippleRadius={22} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>
        <Text fontSize={20} fontWeight={700} color={c.ink}>
          Updates
        </Text>
      </Row>
      <Column style={{ paddingHorizontal: 20, gap: 12 }}>
        <Column style={card}>
          {lines().map((l) => (
            <Text key={l} fontSize={13} color={c.ink}>
              {l}
            </Text>
          ))}
        </Column>
        <Pressable onPress={checkNow} rippleColor="#FFFFFF" alignItems="center" style={{ padding: 14, borderRadius: 12, backgroundColor: busy() ? c.disabled : c.primary }}>
          <Text fontSize={15} fontWeight={700} color={c.white}>
            {busy() ? "Checking…" : "Check now"}
          </Text>
        </Pressable>
      </Column>
    </Column>
  )
}
