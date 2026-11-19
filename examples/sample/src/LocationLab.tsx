// A dev screen for the location plugin. The phone test (tools/plugin-phone/location.ts) reads these lines and the log lines
// "location-lab ...", so keep their wording. Coordinates and addresses show on screen, and only there: they never go in a
// log line, only the provider, accuracy and age.
import { Column, Pressable, Scroll, Text } from "@zeronative/ui"
import { nav, onAppState, Os, Permissions, scheme, signal } from "@zeronative/core"
import { Location, type Accuracy, type Position, type PositionResult } from "@zeronative/location"
import { c } from "./tokens"

function LocationLabButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} alignItems="center" style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: c.primary }}>
      <Text fontSize={13} fontWeight={600} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

function LocationLabLine(props: { text: string }) {
  return (
    <Text fontSize={13} color={scheme("#111111", "#EEEEEE")}>
      {props.text}
    </Text>
  )
}

/** What may go in a log line: no coordinates. */
const describe = (p: Position) => `${p.provider} ${Math.round(p.coords.accuracy ?? -1)}m age ${p.ageMs}ms${p.mocked ? " mocked" : ""}`
const where = (p: Position) => `${p.coords.latitude.toFixed(5)}, ${p.coords.longitude.toFixed(5)} (±${Math.round(p.coords.accuracy ?? -1)} m, ${p.provider})`

export function LocationLabScreen() {
  const status = signal("ready")
  const state = signal("")
  const position = signal("")
  const watched = signal("")
  const address = signal("")
  let last: Position | null = null
  let stopWatch: (() => void) | null = null
  let fixes = 0
  const say = (text: string) => {
    console.info(`location-lab ${text}`)
    status.set(text)
  }

  const readStatus = () =>
    Location.status().then((s) => {
      state.set(`permission ${s.permission}, precise ${s.precise}, location ${s.enabled ? "on" : "off"}, gps ${s.gps}, network ${s.network}`)
      say(`status permission=${s.permission} precise=${s.precise} enabled=${s.enabled} gps=${s.gps} network=${s.network}`)
    })

  const ask = (precise: boolean) => {
    console.info(`location-lab permission asked precise=${precise}`)
    Location.requestPermission({ precise }).then((r) => say(`permission ${r.permission} precise=${r.precise}`))
  }

  // Core's short name "location" is the precise permission alone. Android 12+ may ignore that request: this shows it.
  const coreAsk = () => {
    console.info("location-lab core asked")
    Permissions.request(["location"]).then(
      (r) => say(`core location ${r.location}`),
      (e: { code?: string }) => say(`core location error ${e.code}`),
    )
  }

  const show = (name: string, r: PositionResult) => {
    if (r.position) {
      last = r.position
      position.set(where(r.position))
      say(`once ${name}: fix ${describe(r.position)}`)
    } else {
      say(`once ${name}: none ${r.reason}${r.lastKnown ? ` (last known ${describe(r.lastKnown)})` : ""}`)
    }
  }

  const once = (name: string, accuracy: Accuracy, timeoutMs?: number, maxAgeMs?: number) => {
    console.info(`location-lab once ${name} asked`)
    const t0 = Date.now()
    Location.getCurrentPosition({ accuracy, timeoutMs, maxAgeMs }).then((r) => {
      console.info(`location-lab once ${name} took ${Date.now() - t0}ms`)
      show(name, r)
    })
  }

  const watch = () => {
    if (stopWatch) return say("watch: already on")
    fixes = 0
    stopWatch = Location.watchPosition(
      (p) => {
        fixes++
        last = p
        watched.set(`${fixes} fixes, last ${where(p)}`)
        console.info(`location-lab watch: fix ${describe(p)}`)
      },
      { accuracy: "balanced", intervalMs: 2000 },
      (reason) => say(`watch: error ${reason}`),
    )
    say("watch: on")
  }

  const stop = () => {
    stopWatch?.()
    stopWatch = null
    say(`watch: stopped after ${fixes} fixes`)
  }

  const reverse = () => {
    if (!last) return say("reverse: no position yet")
    Location.reverseGeocode(last.coords.latitude, last.coords.longitude, { max: 3 }).then((r) => {
      const a = r.addresses[0]
      address.set(a ? `${a.name ?? ""}, ${a.city ?? ""} ${a.postalCode ?? ""} (${r.addresses.length} found)` : `none: ${r.reason}`)
      say(a ? `reverse: ${r.addresses.length} found, pincode ${a.postalCode ? "yes" : "no"}` : `reverse: none ${r.reason}`)
    })
  }

  const forward = () =>
    Location.geocode("Koramangala, Bengaluru, India").then((r) => {
      const a = r.addresses[0]
      address.set(a ? `${a.latitude?.toFixed(4)}, ${a.longitude?.toFixed(4)}: ${a.name ?? ""} ${a.postalCode ?? ""}` : `none: ${r.reason}`)
      say(a ? `geocode: ${r.addresses.length} found` : `geocode: none ${r.reason}`)
    })

  // Google's dialog; with no Play services the app would open the Location screen instead.
  const turnOn = () => {
    console.info("location-lab turn on asked")
    Location.turnOn().then((r) => {
      say(r.on ? "turn on: on" : `turn on: ${r.reason}`)
      void readStatus()
    })
  }

  // Back from Settings: read the state again, as an app must.
  onAppState((s) => {
    if (s === "active") void readStatus()
  })

  console.info("location-lab open")
  void readStatus()

  return (
    <Scroll style={{ flex: 1, backgroundColor: scheme("#FFFFFF", "#202020") }}>
      <Column gap={10} style={{ padding: 16 }}>
        <LocationLabLine text={`status: ${status()}`} />
        <LocationLabLine text={`state: ${state()}`} />
        <LocationLabLine text={`position: ${position()}`} />
        <LocationLabLine text={`watch: ${watched()}`} />
        <LocationLabLine text={`address: ${address()}`} />
        <LocationLabButton label="Read status" onPress={() => void readStatus()} />
        <LocationLabButton label="Ask permission" onPress={() => ask(true)} />
        <LocationLabButton label="Ask rough only" onPress={() => ask(false)} />
        <LocationLabButton label="Core ask location" onPress={coreAsk} />
        <LocationLabButton label="Get once" onPress={() => once("balanced", "balanced", 8000)} />
        <LocationLabButton label="Get once high" onPress={() => once("high", "high", 15000)} />
        <LocationLabButton label="Get once low" onPress={() => once("low", "low", 8000)} />
        <LocationLabButton label="Get once 1s high" onPress={() => once("short", "high", 1000)} />
        <LocationLabButton label="Get cached" onPress={() => once("cached", "balanced", 8000, 600000)} />
        <LocationLabButton label="Last known" onPress={() => Location.lastKnown().then((p) => say(p ? `last known: ${describe(p)}` : "last known: none"))} />
        <LocationLabButton label="Watch" onPress={watch} />
        <LocationLabButton label="Stop watch" onPress={stop} />
        <LocationLabButton label="Reverse geocode" onPress={reverse} />
        <LocationLabButton label="Geocode" onPress={forward} />
        <LocationLabButton label="Turn on location" onPress={turnOn} />
        <LocationLabButton label="Location settings" onPress={() => Location.openSettings().then((ok) => say(`settings opened ${ok}`))} />
        <LocationLabButton label="App settings" onPress={() => void Os.openSettings()} />
        <LocationLabButton label="Rebuild screen" onPress={() => nav.replace("locationLab")} />
      </Column>
    </Scroll>
  )
}
