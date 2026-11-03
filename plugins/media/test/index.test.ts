import { beforeEach, expect, test } from "bun:test"
import { installCalls } from "../../../packages/core/src/calls"
import { installEvents } from "../../../packages/core/src/events"
import type { LaunchRecord } from "../../../packages/core/src/launches"
import { createStorage } from "../../../packages/core/src/storage"
import { installFakeHost, type FakeHost } from "../../../packages/core/test/fake-host"
import { Media, type MediaFile } from "../src/index"

let host: FakeHost
const reply = (r: object) => globalThis.__zn_onEvent(0, 7, JSON.stringify(r))
const emit = (payload: LaunchRecord) => globalThis.__zn_onEvent(0, 8, JSON.stringify({ module: "Launches", event: "result", payload }))
const save = (r: LaunchRecord) => createStorage("zn.launch").set(`launch.record.${r.key}`, JSON.stringify(r))
const unsave = () => createStorage("zn.launch").delete("launch.record.media")
const later = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const file: MediaFile = { handle: "zn://file/media-a-0.jpg", uri: "file:///x/media-a-0.jpg", width: 10, height: 20, size: 30, mime: "image/jpeg", name: "IMG.jpg" }
const result = (id: string): LaunchRecord => ({ key: "media", id, status: "result", resultCode: -1, data: null, extras: {} })

/** Answers the newest call of [method], once it has come. */
async function answer(method: string, value: unknown) {
  await later()
  const c = host.calls.filter((x) => x.method === method).at(-1)
  expect(c).toBeDefined()
  reply({ id: c!.id, ok: true, value })
  await later()
  return c!
}
const names = () => host.calls.map((c) => c.method)

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
})

test("pickPhotos opens, collects, then acks and forgets, and the promise gets the files", async () => {
  const p = Media.pickPhotos({ maxSize: 800, quality: 70, max: 3 })
  const open = await answer("pickPhotos", { launched: true, id: "a" })
  expect(open).toMatchObject({ module: "Media", args: { maxSize: 800, quality: 70, max: 3, __v: 1 } })
  emit(result("a"))
  const collect = await answer("collect", { status: "ok", files: [file], skipped: 0 })
  expect(collect.args).toMatchObject({ id: "a" })
  const ack = await answer("ack", true)
  expect(ack).toMatchObject({ module: "Launches", args: { key: "media", id: "a" } })
  await answer("forget", true)
  expect(await p).toEqual({ status: "ok", files: [file], skipped: 0 })
})

test("a launch that didn't open fails at once with its reason, and hears nothing", async () => {
  const p = Media.pickFile({ types: ["application/pdf"] })
  await answer("pickFile", { launched: false, reason: "no_app", id: "a" })
  expect(await p).toEqual({ status: "failed", reason: "no_app", files: [] })
  expect(names()).toEqual(["pickFile"])
})

test("a result for another id isn't this promise's", async () => {
  let settled = false
  void Media.pickPhotos().then(() => (settled = true))
  await answer("pickPhotos", { launched: true, id: "a" })
  emit(result("other"))
  await later()
  expect(settled).toBe(false)
  expect(names()).not.toContain("collect")
})

test("back from the picker with nothing is 'cancelled'", async () => {
  const p = Media.pickPhotos()
  await answer("pickPhotos", { launched: true, id: "a" })
  emit({ ...result("a"), resultCode: 0 })
  await answer("collect", { status: "cancelled", files: [] })
  await answer("ack", true)
  await answer("forget", true)
  expect((await p).status).toBe("cancelled")
})

test("a 'lost' launch never asks native for files, and is cleared", async () => {
  const p = Media.pickPhotos()
  await answer("pickPhotos", { launched: true, id: "a" })
  emit({ key: "media", id: "a", status: "lost" })
  await answer("ack", true)
  await answer("forget", true)
  expect(await p).toEqual({ status: "lost", files: [] })
  expect(names()).not.toContain("collect")
})

test("a collect that fails gives its code, and the launch is still cleared", async () => {
  const p = Media.pickPhotos()
  await answer("pickPhotos", { launched: true, id: "a" })
  emit(result("a"))
  await later()
  const c = host.calls.find((x) => x.method === "collect")!
  reply({ id: c.id, ok: false, code: "no_activity", error: "x" })
  await answer("ack", true)
  await answer("forget", true)
  expect(await p).toEqual({ status: "failed", reason: "no_activity", files: [] })
})

test("after a kill the result comes to onResult, and stays until ack", async () => {
  save(result("a")) // no promise: this is a new process
  const heard: unknown[] = []
  let ack = () => {}
  Media.onResult((r, a) => {
    heard.push(r)
    ack = a
  })
  await answer("collect", { status: "ok", files: [file], skipped: 0 })
  expect(heard).toEqual([{ status: "ok", files: [file], skipped: 0 }])
  expect(names()).not.toContain("ack")
  ack()
  await answer("ack", true)
  await answer("forget", true)
})

test("onResult leaves alone a launch a promise waits for", async () => {
  const heard: unknown[] = []
  Media.onResult((r) => heard.push(r))
  const p = Media.pickPhotos()
  await answer("pickPhotos", { launched: true, id: "a" })
  emit(result("a"))
  await answer("collect", { status: "ok", files: [file] })
  await answer("ack", true)
  await answer("forget", true)
  await p
  expect(heard).toEqual([])
  expect(names().filter((n) => n === "collect")).toHaveLength(1)
})

test("a result nobody took doesn't block a new pick", async () => {
  save(result("old"))
  const p = Media.pickPhotos()
  await answer("ack", true)
  unsave()
  const forget = await answer("forget", true)
  expect(forget.args).toMatchObject({ id: "old" })
  await answer("pickPhotos", { launched: false, reason: "no_app" })
  await p
})

test("takePhoto asks for the camera only when native says it must, then tries again", async () => {
  const p = Media.takePhoto({ quality: 60 })
  await answer("takePhoto", { launched: false, reason: "camera_permission" })
  const ask = await answer("request", { camera: "granted" })
  expect(ask).toMatchObject({ module: "Permissions", args: { names: ["camera"] } })
  await answer("takePhoto", { launched: true, id: "b" })
  expect(host.calls.filter((c) => c.method === "takePhoto")).toHaveLength(2)
  emit(result("b"))
  await answer("collect", { status: "ok", files: [file] })
  await answer("ack", true)
  await answer("forget", true)
  expect((await p).status).toBe("ok")
})

test("takePhoto reports a refused camera", async () => {
  const denied = Media.takePhoto()
  await answer("takePhoto", { launched: false, reason: "camera_permission" })
  await answer("request", { camera: "denied" })
  expect(await denied).toEqual({ status: "failed", reason: "camera_denied", files: [] })
  const blocked = Media.takePhoto()
  await answer("takePhoto", { launched: false, reason: "camera_permission" })
  await answer("request", { camera: "blocked" })
  expect(await blocked).toEqual({ status: "failed", reason: "camera_blocked", files: [] })
})

test("edit and cleanup pass through", async () => {
  const crop = { x: 1, y: 2, width: 3, height: 4 }
  const e = Media.edit({ handle: file.handle, rotate: 90, crop, maxSize: 100 })
  const c = await answer("edit", file)
  expect(c.args).toMatchObject({ handle: file.handle, rotate: 90, crop, maxSize: 100 })
  expect(await e).toEqual(file)
  const clean = Media.cleanup({ olderThanMs: 0, keep: [file.handle] })
  await answer("cleanup", { deleted: 2, bytes: 100 })
  expect(await clean).toEqual({ deleted: 2, bytes: 100 })
})

test("nothing here takes a path: edit needs a handle, and native reads no uri from JS", async () => {
  const p = Media.pickPhotos()
  await answer("pickPhotos", { launched: true, id: "a" })
  emit(result("a"))
  const c = await answer("collect", { status: "ok", files: [] })
  expect(Object.keys(c.args).sort()).toEqual(["__v", "id"])
  await answer("ack", true)
  await answer("forget", true)
  await p
})
