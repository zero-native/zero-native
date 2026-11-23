// `zn dev` end to end with a fake phone: the server builds the sample, a phone that says HELLO gets the whole build
// (a frame of more than a megabyte: Bun's write takes only part of it at once), and a JS error comes back mapped.
// The phones' side of the wire: android/runtime/.../ZnDev.kt, ios/ZnRuntime/Swift/ZnDevWire.swift (ios/tests/dev).
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { networkInterfaces, tmpdir } from "node:os"
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
    // Without --lan: this computer only, and it says how a real iPhone gets in.
    expect(out).toContain("run with --lan")
    const lanAddress = lanIPv4()
    if (lanAddress) expect(await reaches(lanAddress, port)).toBe(false)
  } finally {
    server.kill()
    await server.exited
    await reading.catch(() => {})
    rmSync(outDir, { recursive: true, force: true })
  }
}, 200_000)

/** The text without its colours. */
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")

/** One of this computer's network addresses a phone on the same Wi-Fi would use, or undefined (no network). */
function lanIPv4(): string | undefined {
  return Object.values(networkInterfaces()).flat().find((a) => a?.family === "IPv4" && !a.internal)?.address
}

/** Says hello from [host] and waits for the first frame back: its type, or 0 when nothing came (or no connection). */
async function hello(host: string, port: number, device: string, app = "sample"): Promise<number> {
  let type = 0
  try {
    const socket = await Bun.connect({ hostname: host, port, socket: { data(_s, chunk) { if (!type && chunk.length >= 5) type = chunk[4] } } })
    socket.write(frame(10, JSON.stringify({ device, hash: "app", os: "ios", app })))
    const t = Date.now()
    while (!type && Date.now() - t < 20_000) await Bun.sleep(50)
    socket.end()
  } catch {}
  return type
}

async function reaches(host: string, port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: host, port, socket: { data() {} } })
    socket.end()
    return true
  } catch {
    return false
  }
}

test("zn dev --lan also takes phones from this computer's network (a real iPhone), IPv4 and IPv6", async () => {
  const port = 20000 + Math.floor(Math.random() * 2000)
  const outDir = mkdtempSync(join(tmpdir(), "zn-dev-test-"))
  // No Bonjour here: a test shouldn't advertise on the network (dns-sd is checked by hand: ios/tests/README.md).
  const server = Bun.spawn(["bun", "run", join(root, "tools/zn-dev.ts"), "--lan"], {
    cwd: root,
    env: { ...process.env, ZN_DEV_PORT: String(port), ZN_DEV_ADB: "0", ZN_DEV_OUT: outDir, ZN_DEV_BONJOUR: "0" },
    stdout: "pipe",
    stderr: "pipe",
  })
  let out = ""
  const reading = (async () => {
    for await (const chunk of server.stdout) out += new TextDecoder().decode(chunk)
  })()
  try {
    const t0 = Date.now()
    while (!/start: (built|build failed)/.test(out) && Date.now() - t0 < 170_000) await Bun.sleep(200)
    expect(out).toContain("start: built")
    expect(out).toContain("anyone on this network")
    expect(await hello("127.0.0.1", port, "usb phone")).toBe(1)
    expect(await hello("::1", port, "v6 phone")).toBe(1)
    const address = lanIPv4()
    if (address) {
      expect(out).toContain(`iPhone: this computer is ${address}`)
      expect(await hello(address, port, "lan phone")).toBe(1)
      // A phone from the network shows where it is; one through USB or the simulator doesn't.
      expect(plain(out)).toContain(`phone connected: lan phone (ios, ${address})`)
    }
    expect(plain(out)).toContain("phone connected: usb phone (ios)\n")
    // A phone running another app is warned about (the sample's bundle is "sample", zn-ota.json's app).
    expect(await hello("127.0.0.1", port, "billing phone", "billing")).toBe(1)
    expect(plain(out)).toContain('billing phone runs the app "billing", this serves "sample"')
    expect(plain(out)).not.toContain('usb phone runs the app')
  } finally {
    server.kill()
    await server.exited
    await reading.catch(() => {})
    rmSync(outDir, { recursive: true, force: true })
  }
}, 200_000)

/** The dns-sd advertisements for [port] still running (their command lines). */
function advertisements(port: number): string[] {
  const r = Bun.spawnSync(["pgrep", "-fl", `_zn-dev._tcp local ${port} `])
  return r.stdout.toString().split("\n").filter((l) => l.includes("dns-sd -R"))
}

// macOS only (dns-sd): it advertises on this network for a few seconds.
test.skipIf(!Bun.which("dns-sd"))("zn dev --lan's Bonjour says app= and mac=, and stops however the server ends", async () => {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const port = 22000 + Math.floor(Math.random() * 2000)
    const outDir = mkdtempSync(join(tmpdir(), "zn-dev-test-"))
    const server = Bun.spawn(["bun", "run", join(root, "tools/zn-dev.ts"), "--lan", "--name", "bonjour-test"], {
      cwd: root,
      env: { ...process.env, ZN_DEV_PORT: String(port), ZN_DEV_ADB: "0", ZN_DEV_OUT: outDir, ZN_DEV_BONJOUR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    let out = ""
    const reading = (async () => {
      for await (const chunk of server.stdout) out += new TextDecoder().decode(chunk)
    })()
    try {
      const t0 = Date.now()
      while (!advertisements(port).length && Date.now() - t0 < 20_000) await Bun.sleep(200)
      const [line] = advertisements(port)
      expect(line).toContain("app=bonjour-test")
      expect(line).toMatch(/mac=\S+/)
      expect(plain(out)).toMatch(/advertised on this network as "zn dev bonjour-test on [^"]+"/)
    } finally {
      server.kill(signal)
      await server.exited
      await reading.catch(() => {})
      rmSync(outDir, { recursive: true, force: true })
    }
    // The shell around dns-sd sees the server gone within a second or two.
    const t1 = Date.now()
    while (advertisements(port).length && Date.now() - t1 < 6_000) await Bun.sleep(200)
    expect(advertisements(port)).toEqual([])
  }
}, 60_000)

test("zn dev refuses an unknown flag with its usage (no stack trace)", () => {
  const r = Bun.spawnSync(["bun", "run", join(root, "tools/zn-dev.ts"), "--foo"], { cwd: root, env: { ...process.env, ZN_DEV_ADB: "0" } })
  expect(r.exitCode).toBe(1)
  const err = r.stderr.toString()
  expect(err).toContain("usage: zn dev")
  expect(err).not.toContain("    at ")
})
