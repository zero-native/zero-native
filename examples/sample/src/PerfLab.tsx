// A dev screen for the Performance plugin. The phone test (tools/plugin-phone/perf.ts) reads the log lines
// "perf-lab ..." and Firebase's own "FirebasePerformance" lines, so keep their wording.
import { Column, Pressable, Scroll, Text } from "@zeronative/ui"
import { fetch, nav, scheme, signal } from "@zeronative/core"
import { Perf } from "@zeronative/firebase-perf"
import { c } from "./tokens"

function PerfLabButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} alignItems="center" style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: c.primary }}>
      <Text fontSize={13} fontWeight={600} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

function PerfLabLine(props: { text: string }) {
  return (
    <Text fontSize={13} color={scheme("#111111", "#EEEEEE")}>
      {props.text}
    </Text>
  )
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function PerfLabScreen() {
  const status = signal("ready")
  const say = (text: string) => {
    console.info(`perf-lab ${text}`)
    status.set(text)
  }

  const readStatus = () => Perf.status().then((s) => say(`status available=${s.available} enabled=${s.enabled}`))

  const customTrace = () =>
    Perf.trace("zn_lab_trace", async (t) => {
      await t.putAttribute("lab_step", "custom")
      await t.incrementMetric("lab_items", 3)
      await wait(400)
    }).then(() => say("trace stopped"))

  // Through core's fetch: the plugin's interceptor traces it. The query is left out of what Firebase sees.
  const fetchPage = () =>
    fetch("https://www.gstatic.com/generate_204?lab=perf").then(
      (r) => say(`fetch status=${r.status}`),
      (e: Error) => say(`fetch failed ${e.message}`),
    )

  return (
    <Scroll style={{ flex: 1, backgroundColor: scheme("#FFFFFF", "#202020") }}>
      <Column gap={10} style={{ padding: 16 }}>
        <PerfLabLine text={`status: ${status()}`} />
        <PerfLabButton label="Read status" onPress={() => void readStatus()} />
        <PerfLabButton label="Custom trace" onPress={() => void customTrace()} />
        <PerfLabButton label="Fetch a page" onPress={() => void fetchPage()} />
        <PerfLabButton label="Open the Analytics lab" onPress={() => nav.push("analyticsLab")} />
        <PerfLabLine text="Traces reach the Firebase console after some minutes. Each screen is a trace (screen_<route>)." />
      </Column>
    </Scroll>
  )
}
