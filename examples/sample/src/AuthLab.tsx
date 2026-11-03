// A dev screen for the auth plugin. The phone test (tools/plugin-phone/auth.ts) reads these lines and the log lines "auth-lab ...",
// so keep their wording. The phone number and the OTP show on screen, and only there: they never go in a log line.
import { Column, Pressable, Scroll, Text } from "@zero-native/ui"
import { nav, restorableSignal, scheme, signal } from "@zero-native/core"
import { Auth, type ListenOptions } from "@zero-native/auth"
import { c } from "./tokens"

function AuthLabButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} alignItems="center" style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: c.primary }}>
      <Text fontSize={13} fontWeight={600} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

function AuthLabLine(props: { text: string }) {
  return (
    <Text fontSize={13} color={scheme("#111111", "#EEEEEE")}>
      {props.text}
    </Text>
  )
}

export function AuthLabScreen() {
  const draft = restorableSignal("draft", "") // comes back after a kill, as a real login screen's would
  const status = signal("ready")
  const phone = signal("")
  const code = signal("")
  const hash = signal("")
  const say = (text: string) => {
    console.info(`auth-lab ${text}`)
    status.set(text)
  }

  const askHint = () => {
    if (draft.peek() === "") draft.set(`lab-${Date.now()}`)
    console.info("auth-lab hint asked")
    Auth.phoneHint({ draft: draft.peek() }).then((r) => {
      phone.set(r.phone ?? "")
      say(r.phone !== null ? "hint: picked" : `hint: none ${r.reason}`)
    })
  }

  const listen = (name: string, options?: ListenOptions) => {
    console.info(`auth-lab listen ${name}`)
    Auth.listenForOtp(options).then((r) => {
      code.set(r.code ?? "")
      say(r.code !== null ? `otp ${name}: code` : `otp ${name}: none ${r.reason}`)
    })
  }

  const getHash = () =>
    Auth.appHash().then((h) => {
      hash.set(h)
      say(`hash: ${h}`)
    })

  const listenAndJoin = () => {
    listen("joined-a", { key: "lab" })
    listen("joined-b", { key: "lab" })
  }

  const listenTwice = () => {
    listen("first")
    listen("second")
  }

  // A real login screen asks as it opens. So a rebuilt screen asks here too: the plugin must not bring the sheet back.
  if (draft.peek() !== "") {
    console.info("auth-lab rebuilt")
    askHint()
  } else {
    console.info("auth-lab open")
  }

  return (
    <Scroll style={{ flex: 1, backgroundColor: scheme("#FFFFFF", "#202020") }}>
      <Column gap={10} style={{ padding: 16 }}>
        <AuthLabLine text={`status: ${status()}`} />
        <AuthLabLine text={`phone: ${phone()}`} />
        <AuthLabLine text={`otp: ${code()}`} />
        <AuthLabLine text={`hash: ${hash()}`} />
        <AuthLabButton label="Open hint" onPress={askHint} />
        <AuthLabButton label="New login" onPress={() => draft.set("")} />
        <AuthLabButton label="Clear hint" onPress={() => Auth.clearPhoneHint()} />
        <AuthLabButton label="Get hash" onPress={getHash} />
        <AuthLabButton label="Listen" onPress={() => listen("main")} />
        <AuthLabButton label="Listen 3s" onPress={() => listen("short", { timeoutMs: 3000 })} />
        <AuthLabButton label="Listen pattern" onPress={() => listen("pattern", { pattern: "code (\\d{6})" })} />
        <AuthLabButton label="Listen bad pattern" onPress={() => listen("bad", { pattern: "(" })} />
        <AuthLabButton label="Listen twice" onPress={listenTwice} />
        <AuthLabButton label="Listen and join" onPress={listenAndJoin} />
        <AuthLabButton label="Stop listening" onPress={() => Auth.stopListening()} />
        <AuthLabButton label="Rebuild screen" onPress={() => nav.replace("authLab")} />
      </Column>
    </Scroll>
  )
}
