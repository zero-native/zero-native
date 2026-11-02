// A dev screen for native module foundations (milestone 2 step 2.6): a call, a cancellable slow call, an error code,
// and a native event stream that stops when this screen closes.
import { Column, Pressable, Row, Text } from "@zero-native/ui"
import { flowStore, nav, NativeError, signal } from "@zero-native/core"
import { c } from "./tokens"
import { Device } from "@zero-native/device-test"

function Button(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} alignItems="center" style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, backgroundColor: c.primary }}>
      <Text fontSize={13} fontWeight={600} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

export function ModulesScreen() {
  const info = signal("asking native…")
  const tick = signal(0)
  const status = signal("")

  Device.info().then((d) => info.set(`${d.model} · Android ${d.android} (SDK ${d.sdk})`))

  // FlowStore check (step 2.7): a visit counter that must survive the app being killed.
  const saved = flowStore.read<{ visits: number }>("dev-visits")
  const visits = (saved.status === "ok" ? saved.value.visits : 0) + 1
  const ok = flowStore.write("dev-visits", { visits })
  const store = `FlowStore: visit ${visits} (${saved.status} before, write ${ok ? "ok" : "FAILED"})`
  // Listening starts the native tick source; it stops by itself when this screen closes.
  Device.on("tick", (n) => tick.set(n))

  let slow: AbortController | null = null
  const startSlow = () => {
    slow?.abort()
    slow = new AbortController()
    status.set("slowEcho: waiting 3 s…")
    Device.slowEcho({ text: "hello from native", ms: 3000 }, { signal: slow.signal })
      .then((t) => status.set(`slowEcho answered: ${t}`))
      .catch((e: NativeError) => status.set(`slowEcho: ${e.code}`))
  }
  const fail = () =>
    Device.fail().catch((e: NativeError) => status.set(`fail: code=${e.code}, message=${e.message}`))

  return (
    <Column style={{ flex: 1, backgroundColor: c.bg, padding: 20, gap: 16 }}>
      <Row style={{ gap: 8, alignItems: "center" }}>
        <Pressable onPress={() => nav.back()} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>
        <Text fontSize={20} fontWeight={700} color={c.ink}>
          Native modules
        </Text>
      </Row>
      <Text fontSize={14} color={c.ink}>
        Device: {info()}
      </Text>
      <Text fontSize={14} color={c.ink}>
        Native ticks: {tick()}
      </Text>
      <Text fontSize={14} color={c.ink}>
        {store}
      </Text>
      <Row style={{ gap: 8 }}>
        <Button label="Slow call (3 s)" onPress={startSlow} />
        <Button label="Cancel it" onPress={() => slow?.abort()} />
        <Button label="Failing call" onPress={fail} />
      </Row>
      <Text fontSize={13} color={c.muted}>
        {status()}
      </Text>
    </Column>
  )
}
