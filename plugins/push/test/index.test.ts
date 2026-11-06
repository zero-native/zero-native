import { beforeEach, expect, test } from "bun:test"
import { installCalls } from "../../../packages/core/src/calls"
import { installEvents } from "../../../packages/core/src/events"
import { installTasks, resetTasksForTests } from "../../../packages/core/src/tasks"
import { installFakeHost, type FakeHost } from "../../../packages/core/test/fake-host"
import { ACTION_TASK, DISMISS_TASK, MESSAGE_TASK, messaging, Notifications, Push, TOKEN_TASK, type PushMessage } from "../src/index"

let host: FakeHost

const reply = (id: number, value: unknown) => globalThis.__zn_onEvent(0, 7, JSON.stringify({ id, ok: true, value }))
const refuse = (id: number, code: string) => globalThis.__zn_onEvent(0, 7, JSON.stringify({ id, ok: false, code, error: code }))
const runTask = (id: string, name: string, data: unknown) => globalThis.__zn_onEvent(0, 13, JSON.stringify({ id, name, data }))
const calls = (module: string, method: string) => host.calls.filter((c) => c.module === module && c.method === method)
const last = (module: string, method: string) => calls(module, method).at(-1)!
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
  resetTasksForTests()
  installTasks()
  host.calls.length = 0
})

const message: PushMessage = {
  messageId: "0:1",
  from: "/topics/offers",
  sentAt: 1_700_000_000_000,
  priority: "high",
  originalPriority: "high",
  inFront: false,
  data: { type: "offer", id: "12" },
  notification: null,
}

test("the task names match the native side's", () => {
  expect([MESSAGE_TASK, TOKEN_TASK, DISMISS_TASK]).toEqual(["push.message", "push.token", "push.dismissed"])
})

test("onMessage runs for a message task and answers done", async () => {
  const seen: PushMessage[] = []
  Push.onMessage((m) => {
    seen.push(m)
  })
  runTask("1", MESSAGE_TASK, message)
  await tick()
  expect(seen).toEqual([message])
  expect(last("Tasks", "done").args).toMatchObject({ id: "1", outcome: "done" })
})

test("a handler that throws answers failed, so the service stops waiting", async () => {
  Push.onTokenRefresh(() => {
    throw new Error("server down")
  })
  runTask("2", TOKEN_TASK, { token: "t1" })
  await tick()
  expect(last("Tasks", "done").args).toMatchObject({ id: "2", outcome: "failed" })
})

test("getToken gives the token, or null with a reason, and never rejects", async () => {
  const a = Push.getToken()
  reply(last("Push", "getToken").id, { token: "abc", reason: null })
  expect(await a).toEqual({ token: "abc", reason: null })

  const b = Push.getToken()
  refuse(last("Push", "getToken").id, "unavailable")
  expect(await b).toEqual({ token: null, reason: "unavailable" })
})

test("show passes every option, and a refused call answers not shown", async () => {
  const p = Notifications.show({
    id: "offer-12",
    channelId: "offers",
    title: "Cafe",
    body: "10% off",
    link: "zn://sample/dev/push",
    group: { key: "offers", summaryFormat: "%d new offers" },
    data: { id: "12" },
  })
  const c = last("Notifications", "show")
  expect(c.args).toMatchObject({ id: "offer-12", channelId: "offers", group: { key: "offers" }, data: { id: "12" } })
  refuse(c.id, "failed")
  expect(await p).toEqual({ shown: false, reason: "off" })
})

test("canShow answers the reason, or null", async () => {
  const a = Notifications.canShow("offers")
  expect(last("Notifications", "canShow").args).toMatchObject({ channelId: "offers" })
  reply(last("Notifications", "canShow").id, { reason: null })
  expect(await a).toBeNull()

  const b = Notifications.canShow()
  expect("channelId" in last("Notifications", "canShow").args).toBe(false)
  reply(last("Notifications", "canShow").id, { reason: "off" })
  expect(await b).toBe("off")
})

test("onDismiss hears the id and data", async () => {
  const seen: string[] = []
  Notifications.onDismiss((e) => {
    seen.push(`${e.id}:${e.data.id}`)
  })
  runTask("3", DISMISS_TASK, { id: "offer-12", data: { id: "12" } })
  await tick()
  expect(seen).toEqual(["offer-12:12"])
})

test("RN Firebase's names: getToken gives a string, topics map over", async () => {
  const m = messaging()
  const t = m.getToken()
  reply(last("Push", "getToken").id, { token: null, reason: "not_now" })
  expect(await t).toBe("")
  void m.subscribeToTopic("ota-android-staging")
  expect(last("Push", "subscribe").args).toMatchObject({ topic: "ota-android-staging" })
})

test("getInitialNotification answers the message or null, and never rejects", async () => {
  const opened = { messageId: "0:1", from: "866", sentAt: 5, data: { lab: "opened" } }
  const p = Push.getInitialNotification()
  reply(last("Push", "getInitialNotification").id, opened)
  expect(await p).toEqual(opened)
  const q = messaging().getInitialNotification()
  refuse(last("Push", "getInitialNotification").id, "unavailable")
  expect(await q).toBeNull()
})

test("onNotificationOpenedApp hears the native opened event until unsubscribed", () => {
  const seen: string[] = []
  const off = Push.onNotificationOpenedApp((m) => seen.push(m.data.lab ?? "-"))
  const send = () => globalThis.__zn_onEvent(0, 8, JSON.stringify({ module: "Push", event: "opened", payload: { messageId: "0:2", from: null, sentAt: 0, data: { lab: "tap" } } }))
  send()
  off()
  send()
  expect(seen).toEqual(["tap"])
})

test("the app's own notifications: a press with id and data, at start or while running (notifee's PRESS)", async () => {
  const p = Notifications.getInitialNotification()
  reply(last("Notifications", "getInitialNotification").id, { id: "cb-1", data: { type: "cashback", txn: "T9" } })
  expect(await p).toEqual({ id: "cb-1", data: { type: "cashback", txn: "T9" } })
  // An older app (native version 2) answers "unavailable": null, never a rejection.
  const q = Notifications.getInitialNotification()
  refuse(last("Notifications", "getInitialNotification").id, "unavailable")
  expect(await q).toBeNull()

  const seen: string[] = []
  const off = Notifications.onPress((n) => seen.push(`${n.id}:${n.data.type}`))
  const send = () =>
    globalThis.__zn_onEvent(0, 8, JSON.stringify({ module: "Notifications", event: "pressed", payload: { id: "o-2", data: { type: "offer" } } }))
  send()
  off()
  send()
  expect(seen).toEqual(["o-2:offer"])
})

test("requestPermission uses core's notifications permission; RN's names answer AuthorizationStatus", async () => {
  const p = Push.requestPermission()
  const c = last("Permissions", "request")
  expect(c.args).toMatchObject({ names: ["notifications"] })
  reply(c.id, { notifications: "blocked" })
  expect(await p).toBe("blocked")
  const r = messaging().hasPermission()
  reply(last("Permissions", "status").id, { notifications: "granted" })
  expect(await r).toBe(1)
})

test("auto init passes through, and is false when the plugin is missing", async () => {
  void Push.setAutoInitEnabled(false)
  expect(last("Push", "setAutoInitEnabled").args).toMatchObject({ on: false })
  const p = Push.isAutoInitEnabled()
  refuse(last("Push", "isAutoInitEnabled").id, "unavailable")
  expect(await p).toBe(false)
})

test("onAction runs as the push.action task with the button, data and typed input", async () => {
  const seen: string[] = []
  Notifications.onAction((e) => {
    seen.push(`${e.id}/${e.actionId}/${e.data.from}/${e.input ?? "-"}`)
  })
  runTask("t1", ACTION_TASK, { id: "lab-buttons", actionId: "reply", data: { from: "buttons" }, input: "hi" })
  await tick()
  expect(seen).toEqual(["lab-buttons/reply/buttons/hi"])
})

test("show passes buttons, lines, progress and the lock screen setting through", () => {
  void Notifications.show({
    id: "n1",
    channelId: "c",
    title: "t",
    actions: [{ id: "pay", title: "Pay", link: "zn://x" }, { id: "reply", title: "Reply", input: { placeholder: "Say" } }],
    lines: ["a", "b"],
    progress: { max: 100, current: 30 },
    visibility: "secret",
    number: 2,
  })
  expect(last("Notifications", "show").args).toMatchObject({
    actions: [{ id: "pay", link: "zn://x" }, { id: "reply", input: { placeholder: "Say" } }],
    lines: ["a", "b"],
    progress: { max: 100, current: 30 },
    visibility: "secret",
    number: 2,
  })
})

test("lists answer empty, and a channel null, when the plugin is older or missing", async () => {
  const d = Notifications.getDisplayed()
  refuse(last("Notifications", "getDisplayed").id, "unavailable")
  expect(await d).toEqual([])
  const c = Notifications.getChannels()
  refuse(last("Notifications", "getChannels").id, "unavailable")
  expect(await c).toEqual([])
  const one = Notifications.getChannel("lab_high")
  refuse(last("Notifications", "getChannel").id, "unavailable")
  expect(await one).toBeNull()
  const g = Notifications.createChannelGroup({ id: "lab", name: "Lab" })
  refuse(last("Notifications", "createChannelGroup").id, "unavailable")
  expect(await g).toBe(false)
})

test("schedule sends the notification with its trigger, and answers not scheduled when the plugin is older", async () => {
  const p = Notifications.schedule({ id: "remind", channelId: "c", title: "Pay your bill" }, { at: 1_800_000_000_000, repeat: "daily" })
  const c = last("Notifications", "schedule")
  expect(c.args).toMatchObject({ notification: { id: "remind", title: "Pay your bill" }, at: 1_800_000_000_000, repeat: "daily" })
  refuse(c.id, "unavailable")
  expect(await p).toEqual({ scheduled: false, reason: null })
  const l = Notifications.getScheduled()
  refuse(last("Notifications", "getScheduled").id, "unavailable")
  expect(await l).toEqual([])
  void Notifications.openSettings("battery")
  expect(last("Notifications", "openSettings").args).toMatchObject({ page: "battery" })
})
