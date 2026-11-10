import { beforeEach, expect, test } from "bun:test"
import { installCalls } from "../../../packages/core/src/calls"
import { installEvents } from "../../../packages/core/src/events"
import { installTasks, resetTasksForTests } from "../../../packages/core/src/tasks"
import { installFakeHost, type FakeHost } from "../../../packages/core/test/fake-host"
import * as notifications from "../../notifications/src/index"
import { MESSAGE_TASK, messaging, Notifications, Push, PushEvents, TOKEN_TASK, type PushMessage } from "../src/index"

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

test("old imports keep working: push re-exports the notifications plugin as it is", () => {
  expect(Notifications).toBe(notifications.Notifications)
  expect(PushEvents).toBe(notifications.PushEvents)
  expect([MESSAGE_TASK, TOKEN_TASK]).toEqual(["push.message", "push.token"])
})

test("Push.onMessage is PushEvents' message task", async () => {
  const seen: PushMessage[] = []
  Push.onMessage((m) => {
    seen.push(m)
  })
  runTask("1", MESSAGE_TASK, message)
  await tick()
  expect(seen).toEqual([message])
  expect(last("Tasks", "done").args).toMatchObject({ id: "1", outcome: "done" })
})

test("getToken gives the token, or null with a reason, and never rejects", async () => {
  const a = Push.getToken()
  reply(last("FirebaseMessaging", "getToken").id, { token: "abc", reason: null })
  expect(await a).toEqual({ token: "abc", reason: null })

  const b = Push.getToken()
  refuse(last("FirebaseMessaging", "getToken").id, "unavailable")
  expect(await b).toEqual({ token: null, reason: "unavailable" })
})

test("RN Firebase's names: getToken gives a string, topics map over", async () => {
  const m = messaging()
  const t = m.getToken()
  reply(last("FirebaseMessaging", "getToken").id, { token: null, reason: "not_now" })
  expect(await t).toBe("")
  void m.subscribeToTopic("ota-android-staging")
  expect(last("FirebaseMessaging", "subscribe").args).toMatchObject({ topic: "ota-android-staging" })
})

test("getInitialNotification answers the message or null, and never rejects", async () => {
  const opened = { messageId: "0:1", from: "866", sentAt: 5, data: { lab: "opened" } }
  const p = Push.getInitialNotification()
  reply(last("FirebaseMessaging", "getInitialNotification").id, opened)
  expect(await p).toEqual(opened)
  const q = messaging().getInitialNotification()
  refuse(last("FirebaseMessaging", "getInitialNotification").id, "unavailable")
  expect(await q).toBeNull()
})

test("onNotificationOpenedApp hears the native opened event until unsubscribed", () => {
  const seen: string[] = []
  const off = Push.onNotificationOpenedApp((m) => seen.push(m.data.lab ?? "-"))
  const send = () => globalThis.__zn_onEvent(0, 8, JSON.stringify({ module: "FirebaseMessaging", event: "opened", payload: { messageId: "0:2", from: null, sentAt: 0, data: { lab: "tap" } } }))
  send()
  off()
  send()
  expect(seen).toEqual(["tap"])
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
  expect(last("FirebaseMessaging", "setAutoInitEnabled").args).toMatchObject({ on: false })
  const p = Push.isAutoInitEnabled()
  refuse(last("FirebaseMessaging", "isAutoInitEnabled").id, "unavailable")
  expect(await p).toBe(false)
})
