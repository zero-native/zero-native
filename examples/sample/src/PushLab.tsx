// A dev screen for the push plugin. The phone test (tools/plugin-phone/push.ts) reads the log lines "push-lab ...", so
// keep their wording. The token shows on screen (copy it for a test push from the console) and only its first 8
// characters go in a log line. Message data is never logged as a whole: only the lab's own keys.
import { Column, Pressable, Scroll, Text } from "@zero-native/ui"
import { Clipboard, nav, Permissions, scheme, signal } from "@zero-native/core"
import { Notifications, Push } from "@zero-native/push"
import { c } from "./tokens"

const PICTURE = "https://picsum.photos/id/1080/800/400"
const TOPIC = "zn-sample-lab"

const channels = () =>
  Promise.all([
    Notifications.createChannel({ id: "lab_high", name: "Lab alerts", importance: "high", description: "Push lab: pops up" }),
    Notifications.createChannel({ id: "lab_quiet", name: "Lab quiet", importance: "low", sound: false, vibration: false }),
  ])

/**
 * The lab's tasks, named in main.ts so they exist on a start with no screen. A data message with `lab: "show"` shows a
 * notification from its own `title`, `body`, `link` and `group` keys: how a server-sent "custom notification" works.
 */
export function installPushLab() {
  Push.onMessage(async (m) => {
    const d = m.data
    console.info(`push-lab message lab=${d.lab ?? "-"} inFront=${m.inFront} priority=${m.priority} deleted=${m.deleted ?? false} notification=${m.notification != null}`)
    if (d.lab !== "show") return
    await channels()
    const r = await Notifications.show({
      id: d.id ?? `push-${m.messageId}`,
      channelId: d.channel ?? "lab_high",
      title: d.title ?? "Push lab",
      body: d.body,
      link: d.link,
      imageUrl: d.image,
      ...(d.group ? { group: { key: d.group, title: "Push lab", summaryFormat: "%d lab messages" } } : {}),
      data: { from: "push" },
    })
    console.info(`push-lab message shown=${r.shown} reason=${r.reason}`)
  })
  Push.onTokenRefresh(({ token }) => console.info(`push-lab token refreshed ${token.slice(0, 8)}`))
  Notifications.onDismiss((e) => console.info(`push-lab dismissed ${e.id} from=${e.data.from ?? "-"}`))
}

function PushLabButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} alignItems="center" style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: c.primary }}>
      <Text fontSize={13} fontWeight={600} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

function PushLabLine(props: { text: string }) {
  return (
    <Text fontSize={13} color={scheme("#111111", "#EEEEEE")}>
      {props.text}
    </Text>
  )
}

export function PushLabScreen(props: { from?: string }) {
  const status = signal("ready")
  const token = signal("")
  const say = (text: string) => {
    console.info(`push-lab ${text}`)
    status.set(text)
  }
  if (props.from) say(`opened from ${props.from}`)

  // Channels first, as an app does at start: canShow says "no_channel" before them.
  const readStatus = () =>
    channels()
      .then(() => Promise.all([Push.status(), Notifications.canShow("lab_high")]))
      .then(([s, blocked]) => say(`status available=${s.available} canShow=${blocked ?? "ok"}`))

  const ask = () => {
    console.info("push-lab permission asked")
    Permissions.request(["notifications"]).then(
      (r) => say(`permission ${r.notifications}`),
      (e: { code?: string }) => say(`permission error ${e.code}`),
    )
  }

  const getToken = () =>
    Push.getToken().then((r) => {
      token.set(r.token ?? "")
      say(r.token ? `token ${r.token.slice(0, 8)}` : `no token ${r.reason}`)
    })

  const show = (name: string, extra: Partial<Parameters<typeof Notifications.show>[0]>) =>
    channels()
      .then(() => Notifications.show({ id: `lab-${name}`, channelId: "lab_high", title: `Lab: ${name}`, data: { from: name }, ...extra }))
      .then((r) => say(`show ${name} shown=${r.shown} reason=${r.reason}`))

  const showGroup = async () => {
    await channels()
    for (const n of [1, 2, 3]) {
      await Notifications.show({
        id: `lab-group-${n}`,
        channelId: "lab_quiet",
        title: `Store ${n}`,
        body: `Offer number ${n}`,
        group: { key: "lab-group", title: "Lab offers", summaryFormat: "%d stores have offers", link: "zn://sample/dev/push?from=summary" },
        data: { from: `group-${n}` },
      })
    }
    say("show group 3")
  }

  return (
    <Scroll style={{ flex: 1, backgroundColor: scheme("#FFFFFF", "#202020") }}>
      <Column gap={10} style={{ padding: 16 }}>
        <PushLabLine text={`status: ${status()}`} />
        <PushLabLine text={`token: ${token() || "-"}`} />
        <PushLabButton label="Read status" onPress={() => void readStatus()} />
        <PushLabButton label="Ask permission" onPress={ask} />
        <PushLabButton label="Get token" onPress={() => void getToken()} />
        <PushLabButton label="Copy token" onPress={() => {
          Clipboard.setString(token())
          say("token copied")
        }} />
        <PushLabButton label="Show plain" onPress={() => void show("plain", { body: "A short one" })} />
        <PushLabButton label="Show long text" onPress={() => void show("long", { body: "A longer message that does not fit on one line, so it expands when pulled down." })} />
        <PushLabButton label="Show picture" onPress={() => void show("picture", { body: "With a big picture", imageUrl: PICTURE })} />
        <PushLabButton label="Show with link" onPress={() => void show("link", { body: "Tap to open the push lab", link: "zn://sample/dev/push?from=notification" })} />
        <PushLabButton label="Show group of 3" onPress={() => void showGroup()} />
        <PushLabButton label="Cancel all" onPress={() => void Notifications.cancelAll().then(() => say("cancelled all"))} />
        <PushLabButton label="Subscribe topic" onPress={() => void Push.subscribe(TOPIC).then((ok) => say(`subscribe ${ok}`))} />
        <PushLabButton label="Unsubscribe topic" onPress={() => void Push.unsubscribe(TOPIC).then((ok) => say(`unsubscribe ${ok}`))} />
        <PushLabButton label="Delete token" onPress={() => void Push.deleteToken().then((ok) => say(`token deleted ${ok}`))} />
        <PushLabButton label="Rebuild screen" onPress={() => nav.replace("pushLab")} />
      </Column>
    </Scroll>
  )
}
