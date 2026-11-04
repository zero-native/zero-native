import { beforeEach, expect, test } from "bun:test"
import { installCalls } from "../../../packages/core/src/calls"
import { installEvents } from "../../../packages/core/src/events"
import { installTasks, resetTasksForTests } from "../../../packages/core/src/tasks"
import { installFakeHost, type FakeHost } from "../../../packages/core/test/fake-host"
import { DISMISS_TASK, MESSAGE_TASK, messaging, Notifications, Push, TOKEN_TASK, type PushMessage } from "../src/index"

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
