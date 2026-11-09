// A dev screen for the Remote Config plugin. The phone test (tools/plugin-phone/remote-config.ts) reads the log lines
// "remote-config-lab ...", so keep their wording. The sample's Firebase project has the parameter zn_lab_greeting.
import { Column, Pressable, Scroll, Text } from "@zero-native/ui"
import { scheme, signal } from "@zero-native/core"
import { RemoteConfig } from "@zero-native/firebase-remote-config"
import { c } from "./tokens"

function RemoteConfigLabButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} alignItems="center" style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: c.primary }}>
      <Text fontSize={13} fontWeight={600} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

function RemoteConfigLabLine(props: { text: string }) {
  return (
    <Text fontSize={13} color={scheme("#111111", "#EEEEEE")}>
      {props.text}
    </Text>
  )
}

export function RemoteConfigLabScreen() {
  const status = signal("ready")
  const say = (text: string) => {
    console.info(`remote-config-lab ${text}`)
    status.set(text)
  }

  const read = () => {
    const g = RemoteConfig.getValue("zn_lab_greeting")
    say(`values greeting=${g.asString()} source=${g.getSource()} number=${RemoteConfig.getNumber("zn_lab_number")} available=${RemoteConfig.available}`)
  }

  const setDefaults = () =>
    RemoteConfig.setDefaults({ zn_lab_greeting: "default greeting", zn_lab_number: 7 }).then((ok) => say(`defaults ok=${ok}`))

  // Debug only: fetch every time. A release app keeps Firebase's 12 hours (or its own few hours).
  const fastFetch = () => RemoteConfig.setConfigSettings({ minimumFetchIntervalMillis: 0 }).then((ok) => say(`settings ok=${ok}`))

  const fetchAndActivate = () =>
    RemoteConfig.fetchAndActivate().then((r) => say(`fetched ok=${r.ok} reason=${r.reason} changed=${r.changed} status=${RemoteConfig.lastFetchStatus}`))

  const listen = () => {
    RemoteConfig.onConfigUpdated((e) => say(`updated keys=${e.updatedKeys.join(",") || "-"} error=${e.error ?? "-"}`))
    say("listening")
  }

  return (
    <Scroll style={{ flex: 1, backgroundColor: scheme("#FFFFFF", "#202020") }}>
      <Column gap={10} style={{ padding: 16 }}>
        <RemoteConfigLabLine text={`status: ${status()}`} />
        <RemoteConfigLabButton label="Set defaults" onPress={() => void setDefaults()} />
        <RemoteConfigLabButton label="Read values" onPress={read} />
        <RemoteConfigLabButton label="Fetch every time" onPress={() => void fastFetch()} />
        <RemoteConfigLabButton label="Fetch and activate" onPress={() => void fetchAndActivate()} />
        <RemoteConfigLabButton label="Listen for updates" onPress={listen} />
        <RemoteConfigLabLine text="zn_lab_greeting is set in the sample's Firebase project; zn_lab_number has only a default." />
      </Column>
    </Scroll>
  )
}
