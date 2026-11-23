// `zn dev` end to end with a fake phone: the server builds the sample, a phone that says HELLO gets the whole build
// (a frame of more than a megabyte: Bun's write takes only part of it at once), and a JS error comes back mapped.
// The phones' side of the wire: android/runtime/.../ZnDev.kt, ios/ZnRuntime/Swift/ZnDevWire.swift (ios/tests/dev).
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "../..")

/** A frame as both phones write it: u32 length (big endian, counting the type), u8 type, body. */
function frame(type: number, body: string): Uint8Array {
  const bytes = new TextEncoder().encode(body)
  const out = new Uint8Array(5 + bytes.length)
  new DataView(out.buffer).setUint32(0, bytes.length + 1)
  out[4] = type
  out.set(bytes, 5)
  return out
}

test("zn dev sends a whole build to a phone that says hello, and maps its errors", async () => {
  const port = 18000 + Math.floor(Math.random() * 2000)
  // Its own folder for dev.js / dev.hbc: a `zn dev` running meanwhile keeps sending its own.
  const outDir = mkdtempSync(join(tmpdir(), "zn-dev-test-"))
  const server = Bun.spawn(["bun", "run", join(root, "tools/zn-dev.ts")], {
    cwd: root,
    env: { ...process.env, ZN_DEV_PORT: String(port), ZN_DEV_ADB: "0", ZN_DEV_OUT: outDir },
    stdout: "pipe",
    stderr: "pipe",
  })
  let out = ""
  const reading = (async () => {
    for await (const chunk of server.stdout) out += new TextDecoder().decode(chunk)
  })()
  try {
    // The first build (bundle + hermesc): seconds, more on a busy machine.
    const t0 = Date.now()
    while (!/start: (built|build failed)/.test(out) && Date.now() - t0 < 170_000) await Bun.sleep(200)
    expect(out).toContain("start: built")

    const frames: { type: number; body: Uint8Array }[] = []
    let buffer = new Uint8Array(0)
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        data(_s, chunk) {
          const merged = new Uint8Array(buffer.length + chunk.length)
          merged.set(buffer)
          merged.set(chunk, buffer.length)
          let at = 0
          while (merged.length - at >= 5) {
            const length = new DataView(merged.buffer, at).getUint32(0)
            if (merged.length - at - 4 < length) break
            frames.push({ type: merged[at + 4], body: merged.slice(at + 5, at + 4 + length) })
            at += 4 + length
          }
          buffer = merged.slice(at)
        },
      },
    })
    socket.write(frame(10, JSON.stringify({ device: "test phone", hash: "app", os: "ios", bytecode: 99 })))
    const wait = async (n: number) => {
      const t = Date.now()
      while (frames.length < n && Date.now() - t < 20_000) await Bun.sleep(50)
    }
    await wait(1)
    expect(frames[0]?.type).toBe(1)
    const body = frames[0].body
    const view = new DataView(body.buffer, body.byteOffset)
    const headerLength = view.getUint32(0)
    const header = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + headerLength)))
    expect(header.asset).toBe("main.zn.ui")
    // Whole: the parts the header names fill the frame exactly.
    expect(4 + headerLength + header.templates + header.manifest + header.hbc).toBe(body.length)
    expect(header.hbc).toBeGreaterThan(500_000)
    const manifestAt = 4 + headerLength + header.templates
    const manifest = JSON.parse(new TextDecoder().decode(body.subarray(manifestAt, manifestAt + header.manifest)))
    expect(Array.isArray(manifest.routes)).toBe(true)
    // Hermes bytecode: its magic first.
    expect([...body.subarray(manifestAt + header.manifest, manifestAt + header.manifest + 4)]).toEqual([0xc6, 0x1f, 0xbc, 0x03])

    // A JS error: the server answers with the same id (the stack mapped to TSX where it can).
    socket.write(frame(11, JSON.stringify({ id: 7, text: "event handler threw\nError: boom\n    at f (dev.hbc:1:1)" })))
    await wait(2)
    expect(frames[1]?.type).toBe(3)
    const mapped = JSON.parse(new TextDecoder().decode(frames[1].body))
    expect(mapped.id).toBe(7)
    expect(mapped.text).toContain("Error: boom")

    // Reload: the same build again.
    socket.write(frame(12, "{}"))
    await wait(3)
    expect(frames[2]?.type).toBe(1)
    expect(frames[2].body.length).toBe(body.length)
    socket.end()

    expect(out).toContain("phone connected: test phone")
    expect(out).toContain("(ios)")
  } finally {
    server.kill()
    await server.exited
    await reading.catch(() => {})
    rmSync(outDir, { recursive: true, force: true })
  }
}, 200_000)
