// A dev screen for the push plugin. The phone test (tools/plugin-phone/push.ts) reads the log lines "push-lab ...", so
// keep their wording. The token shows on screen (copy it for a test push from the console) and only its first 8
// characters go in a log line. Message data is never logged as a whole: only the lab's own keys.
import { Column, Pressable, Scroll, Text } from "@zeronative/ui"
import { Clipboard, nav, Permissions, scheme, signal } from "@zeronative/core"
import { Notifications } from "@zeronative/notifications"
import { Push } from "@zeronative/firebase-messaging"
import { c } from "./tokens"

const PICTURE = "https://picsum.photos/id/1080/800/400"
const TOPIC = "zn-sample-lab"

const channels = () =>
  Notifications.createChannelGroup({ id: "lab", name: "Push lab" }).then(() =>
    Promise.all([
      Notifications.createChannel({ id: "lab_high", name: "Lab alerts", importance: "high", description: "Push lab: pops up", groupId: "lab" }),
      Notifications.createChannel({ id: "lab_quiet", name: "Lab quiet", importance: "low", sound: false, vibration: false, groupId: "lab" }),
    ]),
  )

/**
 * The lab's tasks, named in main.ts so they exist on a start with no screen. A data message with `lab: "show"` shows a
 * notification from its own `title`, `body`, `link` and `group` keys: how a server-sent "custom notification" works.
 * `lab: "slow"` takes `ms` (default 20000) to answer, or stops when the task's signal aborts: a slow JS, to see iOS's
 * background push answered in time anyway (tools/push-send.ts --sim <simulator> --background --data lab=slow,ms=40000).
 * `ageMs` is how long ago the message came (a data-only push that waited for the next start on iOS comes late).
 */
export function installPushLab() {
  Push.onMessage(async (m, signal) => {
    const d = m.data
    console.info(`push-lab message lab=${d.lab ?? "-"} inFront=${m.inFront} priority=${m.priority} deleted=${m.deleted ?? false} notification=${m.notification != null} ageMs=${Date.now() - m.sentAt}`)
    if (d.lab === "slow") {
      const ms = Number(d.ms ?? "20000")
      const finished = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(true), ms)
        signal.addEventListener("abort", () => {
          clearTimeout(t)
          resolve(false)
        })
      })
      console.info(`push-lab slow ${finished ? "finished" : "aborted"} (asked ${ms} ms)`)
      return
    }
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
  // Taps on the app's own notifications that had no link (notifee's PRESS).
  Notifications.onPress((n) => console.info(`push-lab pressed ${n.id} from=${n.data.from ?? "-"} txn=${n.data.txn ?? "-"}`))
  void Notifications.getInitialNotification().then((n) => console.info(`push-lab initial press ${n ? `${n.id} from=${n.data.from ?? "-"}` : "none"}`))
  // Taps on notifications FCM showed itself (a `notification` block, app behind or closed).
  void Push.getInitialNotification().then((m) => console.info(`push-lab initial ${m ? `lab=${m.data.lab ?? "-"}` : "none"}`))
  Push.onNotificationOpenedApp((m) => console.info(`push-lab fcm opened lab=${m.data.lab ?? "-"}`))
  // A button with no link. After a reply, show the same id again: Android shows a spinner until then.
  Notifications.onAction(async (e) => {
    console.info(`push-lab action ${e.actionId} on ${e.id} from=${e.data.from ?? "-"} input=${e.input ?? "-"}`)
    if (e.actionId === "reply") {
      await Notifications.show({ id: e.id, channelId: "lab_quiet", title: "Lab: buttons", body: `You said: ${e.input ?? ""}`, silent: true })
    } else {
      await Notifications.cancel(e.id)
    }
  })
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

  // linked = false: a tap on the summary is a press (onPress with the group key and data).
  const showGroup = async (linked = true) => {
    await channels()
    for (const n of [1, 2, 3]) {
      await Notifications.show({
        id: `lab-group-${n}`,
        channelId: "lab_quiet",
        title: `Store ${n}`,
        body: `Offer number ${n}`,
        group: {
          key: "lab-group",
          title: "Lab offers",
          summaryFormat: "%d stores have offers",
          ...(linked ? { link: "zn://sample/dev/push?from=summary" } : { data: { from: "summary" } }),
        },
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
        <PushLabButton
          label="Show HTML, tap = press"
          onPress={() =>
            void show("html", {
              title: "You got <b>₹25</b> cashback",
              body: 'From <b><span style="color:#0A8F08">Store 1</span></b> &amp; more\nTap me: no link, so onPress hears it',
              data: { from: "html", txn: "T9" },
            })
          }
        />
        <PushLabButton label="Show group of 3" onPress={() => void showGroup()} />
        <PushLabButton label="Show group, tap = press" onPress={() => void showGroup(false)} />
        <PushLabButton label="Show with buttons" onPress={() => void show("buttons", {
          body: "Pay, later, or reply",
          actions: [
            { id: "pay", title: "Pay now", link: "zn://sample/dev/push?from=action" },
            { id: "later", title: "Later" },
            { id: "reply", title: "Reply", input: { placeholder: "Type a reply" } },
          ],
        })} />
        <PushLabButton label="Show progress" onPress={() => void show("progress", {
          body: "Uploading the bill", progress: { max: 100, current: 30 }, ongoing: true, onlyAlertOnce: true, category: "progress",
        })} />
        <PushLabButton label="Show private" onPress={() => void show("private", {
          body: "₹499 paid to Lab Store", lines: ["₹499 paid to Lab Store", "Cashback ₹20"], visibility: "secret", number: 2, color: "#E23744",
        })} />
        <PushLabButton label="Schedule in 5 s" onPress={() => void channels()
          .then(() => Notifications.schedule(
            { id: "lab-scheduled", channelId: "lab_high", title: "Lab: scheduled", body: "Set 5 s before", data: { from: "scheduled" } },
            { at: Date.now() + 5000 },
          ))
          .then((r) => say(`schedule once scheduled=${r.scheduled} reason=${r.reason}`))} />
        <PushLabButton label="Schedule daily" onPress={() => void channels()
          .then(() => Notifications.schedule(
            { id: "lab-daily", channelId: "lab_quiet", title: "Lab: daily", body: "Every day" },
            { at: Date.now() + 3_600_000, repeat: "daily" },
          ))
          .then((r) => say(`schedule daily scheduled=${r.scheduled} reason=${r.reason}`))} />
        <PushLabButton label="List scheduled" onPress={() => void Notifications.getScheduled().then((l) =>
          say(`scheduled ${l.length} ${l.map((n) => `${n.id}:${n.repeat ?? "once"}`).join(",")}`))} />
        <PushLabButton label="Power status" onPress={() => void Promise.all([Notifications.canScheduleExact(), Notifications.isBatteryOptimized()])
          .then(([exact, optimized]) => say(`power exact=${exact} optimized=${optimized}`))} />
        <PushLabButton label="Open notification settings" onPress={() => void Notifications.openSettings("notifications").then((ok) => say(`settings notifications opened ${ok}`))} />
        <PushLabButton label="Open exact alarm settings" onPress={() => void Notifications.openSettings("exact_alarms").then((ok) => say(`settings exact_alarms opened ${ok}`))} />
        <PushLabButton label="Open battery settings" onPress={() => void Notifications.openSettings("battery").then((ok) => say(`settings battery opened ${ok}`))} />
        <PushLabButton label="List shown"onPress={() => void Notifications.getDisplayed().then((l) =>
          say(`displayed ${l.length} ${l.map((n) => `${n.id}:${n.data.from ?? "-"}`).join(",")}`))} />
        <PushLabButton label="List channels" onPress={() => void Notifications.getChannels().then((l) =>
          say(`channels ${l.length} ${l.map((ch) => `${ch.id}=${ch.importance}/${ch.groupId ?? "-"}${ch.blocked ? "/blocked" : ""}`).join(",")}`))} />
        <PushLabButton label="Cancel all" onPress={() => void Notifications.cancelAll().then(() => say("cancelled all"))} />
        <PushLabButton label="Subscribe topic" onPress={() => void Push.subscribe(TOPIC).then((ok) => say(`subscribe ${ok}`))} />
        <PushLabButton label="Unsubscribe topic" onPress={() => void Push.unsubscribe(TOPIC).then((ok) => say(`unsubscribe ${ok}`))} />
        <PushLabButton label="Delete token" onPress={() => void Push.deleteToken().then((ok) => say(`token deleted ${ok}`))} />
        <PushLabButton label="Rebuild screen" onPress={() => nav.replace("pushLab")} />
      </Column>
    </Scroll>
  )
}
