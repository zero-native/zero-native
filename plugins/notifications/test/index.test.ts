import { beforeEach, expect, test } from "bun:test"
import { installCalls } from "../../../packages/core/src/calls"
import { installEvents } from "../../../packages/core/src/events"
import { installTasks, resetTasksForTests } from "../../../packages/core/src/tasks"
import { installFakeHost, type FakeHost } from "../../../packages/core/test/fake-host"
import { ACTION_TASK, DISMISS_TASK, MESSAGE_TASK, Notifications, PushEvents, TOKEN_TASK, type PushMessage } from "../src/index"

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
  expect([MESSAGE_TASK, TOKEN_TASK, DISMISS_TASK, ACTION_TASK]).toEqual(["push.message", "push.token", "push.dismissed", "push.action"])
})

test("onMessage runs for a message task and answers done", async () => {
  const seen: PushMessage[] = []
  PushEvents.onMessage((m) => {
    seen.push(m)
  })
  runTask("1", MESSAGE_TASK, message)
  await tick()
  expect(seen).toEqual([message])
  expect(last("Tasks", "done").args).toMatchObject({ id: "1", outcome: "done" })
})

test("a handler that throws answers failed, so the service stops waiting", async () => {
  PushEvents.onTokenRefresh(() => {
    throw new Error("server down")
  })
  runTask("2", TOKEN_TASK, { token: "t1" })
  await tick()
  expect(last("Tasks", "done").args).toMatchObject({ id: "2", outcome: "failed" })
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

test("requestPermission and hasPermission use core's notifications permission, with no push plugin", async () => {
  const p = Notifications.requestPermission()
  const c = last("Permissions", "request")
  expect(c.args).toMatchObject({ names: ["notifications"] })
  reply(c.id, { notifications: "granted" })
  expect(await p).toBe("granted")
  const r = Notifications.hasPermission()
  refuse(last("Permissions", "status").id, "unavailable")
  expect(await r).toBe("denied")
})

test("notifee's shape: android's options go flat (as Android reads them), ios stays a block; the flat fields still work", () => {
  void Notifications.show({
    id: "offer-13",
    title: "Cafe",
    body: "<b>10%</b> off",
    imageUrl: "https://example.com/p.jpg",
    android: { channelId: "offers", bigText: "More", lines: ["a"], color: "#E23744" },
    ios: { subtitle: "Today only", threadId: "offers", interruptionLevel: "timeSensitive", foregroundPresentationOptions: { banner: true, sound: false } },
  })
  const args = last("Notifications", "show").args as Record<string, unknown>
  expect(args).toMatchObject({ id: "offer-13", channelId: "offers", bigText: "More", lines: ["a"], color: "#E23744", imageUrl: "https://example.com/p.jpg" })
  expect(args.ios).toEqual({ subtitle: "Today only", threadId: "offers", interruptionLevel: "timeSensitive", foregroundPresentationOptions: { banner: true, sound: false } })
  expect(args.android).toBeUndefined()
  // android's block wins over a flat field of the same name
  void Notifications.show({ id: "x", title: "t", channelId: "old", android: { channelId: "new" } })
  expect(last("Notifications", "show").args).toMatchObject({ channelId: "new" })
  // schedule converts the same way
  void Notifications.schedule({ id: "r", title: "t", android: { channelId: "offers" }, ios: { sound: false } }, { at: Date.now() + 60_000 })
  expect(last("Notifications", "schedule").args).toMatchObject({ notification: { channelId: "offers", ios: { sound: false } } })
})

test("iOS-only calls answer harmlessly where the module lacks them (Android)", async () => {
  const badge = Notifications.setBadgeCount(3.7)
  expect(last("Notifications", "setBadgeCount").args).toMatchObject({ count: 3 })
  refuse(last("Notifications", "setBadgeCount").id, "unavailable")
  expect(await badge).toBe(false)
  const count = Notifications.getBadgeCount()
  refuse(last("Notifications", "getBadgeCount").id, "unavailable")
  expect(await count).toBe(0)
  const cats = Notifications.getNotificationCategories()
  refuse(last("Notifications", "getNotificationCategories").id, "unavailable")
  expect(await cats).toEqual([])
})

test("badge count goes up and down from what native says, never below 0", async () => {
  const p = Notifications.decrementBadgeCount(5)
  reply(last("Notifications", "getBadgeCount").id, 2)
  await tick()
  expect(last("Notifications", "setBadgeCount").args).toMatchObject({ count: 0 })
  reply(last("Notifications", "setBadgeCount").id, true)
  expect(await p).toBe(true)
})

test("getNotificationSettings falls back to the permission where native lacks it", async () => {
  const p = Notifications.getNotificationSettings()
  refuse(last("Notifications", "getNotificationSettings").id, "unavailable")
  await tick()
  const status = last("Permissions", "status")
  reply(status.id, { notifications: "granted" })
  expect(await p).toEqual({ authorizationStatus: "authorized" })
})
