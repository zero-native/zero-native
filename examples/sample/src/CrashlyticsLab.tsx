// A dev screen for the Crashlytics plugin. The phone test (tools/plugin-phone/crashlytics.ts) reads the log lines
// "crashlytics-lab ...", so keep their wording. Each button makes one kind of report; the console shows it after the
// next start (non-fatals and crashes are sent when the app starts again).
import { Column, Pressable, Scroll, Text } from "@zeronative/ui"
import { nav, scheme, signal } from "@zeronative/core"
import { Crashlytics } from "@zeronative/firebase-crashlytics"
import { Firebase, Installations } from "@zeronative/firebase-app"
import { c } from "./tokens"

function CrashlyticsLabButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} alignItems="center" style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: c.primary }}>
      <Text fontSize={13} fontWeight={600} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

function CrashlyticsLabLine(props: { text: string }) {
  return (
    <Text fontSize={13} color={scheme("#111111", "#EEEEEE")}>
      {props.text}
    </Text>
  )
}

export function CrashlyticsLabScreen() {
  const status = signal("ready")
  const state = signal("")
  const say = (text: string) => {
    console.info(`crashlytics-lab ${text}`)
    status.set(text)
  }

  const readStatus = () =>
    Crashlytics.status().then((s) => {
      state.set(`available ${s.available}, sending ${s.enabled ? "on" : "off"}`)
      say(`status available=${s.available} enabled=${s.enabled}`)
    })
  void readStatus()

  // plugins/firebase-app: the project this build talks to, and this install's id (only its length is logged).
  const app = signal("")
  const readApp = async () => {
    const a = await Firebase.app()
    const id = a.available ? await Installations.getId() : null
    app.set(a.available ? `${a.projectId}, install id ${id ? "yes" : "none"}` : "Firebase off")
    say(`firebase available=${a.available} project=${a.projectId ?? "-"} installId=${id ? id.length : 0}`)
  }

  const setUser = () => {
    void Crashlytics.setUserId("lab-user-1")
    void Crashlytics.setAttributes({ lab_step: "keys", lab_count: 3, lab_flag: true })
    say("user and keys set")
  }

  const caught = () => {
    try {
      JSON.parse("{ not json")
    } catch (e) {
      void Crashlytics.log("crashlytics-lab: about to record a caught error")
      Crashlytics.recordError(e, "CrashlyticsLab.caught").then((ok) => say(`caught error recorded ok=${ok}`))
    }
  }

  // Nobody catches these: core reports them, and the plugin sends them with no JS code of ours.
  const handlerThrows = () => {
    say("handler error thrown")
    throw new Error("crashlytics-lab: a tap handler threw")
  }
  const asyncRejects = () => {
    say("async error thrown")
    void Promise.reject(new TypeError("crashlytics-lab: a promise nobody caught"))
  }

  const setSending = (on: boolean) =>
    Crashlytics.setCrashlyticsCollectionEnabled(on).then((s) => {
      state.set(`available ${s.available}, sending ${s.enabled ? "on" : "off"}`)
      say(`sending ${s.enabled ? "on" : "off"}`)
    })

  const crash = (kind: "kotlin" | "native") => {
    say(`crash ${kind} asked`)
    void Crashlytics.crash(kind)
  }

  return (
    <Scroll style={{ flex: 1, backgroundColor: scheme("#FFFFFF", "#202020") }}>
      <Column gap={10} style={{ padding: 16 }}>
        <CrashlyticsLabLine text={`status: ${status()}`} />
        <CrashlyticsLabLine text={`state: ${state()}`} />
        <CrashlyticsLabLine text={`firebase: ${app()}`} />
        <CrashlyticsLabButton label="Read status" onPress={() => void readStatus()} />
        <CrashlyticsLabButton label="Firebase app" onPress={() => void readApp()} />
        <CrashlyticsLabButton label="Set user and keys" onPress={setUser} />
        <CrashlyticsLabButton label="Record a caught error" onPress={caught} />
        <CrashlyticsLabButton label="Throw in a tap handler" onPress={handlerThrows} />
        <CrashlyticsLabButton label="Reject a promise" onPress={asyncRejects} />
        <CrashlyticsLabButton label="Sending off" onPress={() => void setSending(false)} />
        <CrashlyticsLabButton label="Sending on" onPress={() => void setSending(true)} />
        <CrashlyticsLabButton label="Kotlin crash" onPress={() => crash("kotlin")} />
        <CrashlyticsLabButton label="Native crash (needs NDK)" onPress={() => crash("native")} />
        <CrashlyticsLabButton label="Rebuild screen" onPress={() => nav.replace("crashlyticsLab")} />
        <CrashlyticsLabLine text="Reports reach the Firebase console after the app starts again." />
      </Column>
    </Scroll>
  )
}
