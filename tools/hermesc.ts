// Runs the Hermes bytecode compiler from the `hermes-compiler` package.
// Its version must match com.facebook.hermes:hermes-android in android/runtime/build.gradle.kts.
import { join } from "node:path"
import { existsSync } from "node:fs"

const root = join(import.meta.dir, "..")
const platformDir =
  process.platform === "win32" ? "win64-bin" : process.platform === "darwin" ? "osx-bin" : "linux64-bin"
const exe = process.platform === "win32" ? "hermesc.exe" : "hermesc"
const hermescPath = join(root, "node_modules/hermes-compiler/hermesc", platformDir, exe)

/**
 * Compiles one JS file to optimised Hermes bytecode. Throws with hermesc's output on failure.
 * [extraFlags]: for example `-g1` (line numbers in JS stack traces; `zn dev` uses it).
 */
export async function hermesc(input: string, output: string, extraFlags: string[] = []): Promise<void> {
  if (!existsSync(hermescPath)) {
    throw new Error(`hermesc not found at ${hermescPath}. Run \`bun install\` at the repo root.`)
  }
  // -Xes6-block-scoping: without it this hermesc treats `let` / `const` like `var`, so closures created in a loop
  // all see the last value (found 2026-10-29: every console level logged as "error"). Hidden flag; see
  // docs/v0-findings.md §P.
  // -emit-async-break-check: lets the runtime stop JS that runs past its time limit (an endless loop; step 3.9).
  const flags = ["-O", "-Xes6-block-scoping", "-emit-async-break-check", ...extraFlags]
  const proc = Bun.spawn([hermescPath, ...flags, "-emit-binary", "-out", output, input], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const code = await proc.exited
  if (code !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(`hermesc failed (exit ${code}):\n${err}`)
  }
}

/** The Hermes bytecode format of a .hbc file (99 for hermes-compiler 260318099): a u32 after the 8-byte magic. */
export async function bytecodeVersion(hbcPath: string): Promise<number> {
  const head = new Uint8Array(await Bun.file(hbcPath).slice(0, 12).arrayBuffer())
  const magic = [0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]
  if (head.length < 12 || magic.some((b, i) => head[i] !== b)) throw new Error(`${hbcPath} is not Hermes bytecode`)
  return new DataView(head.buffer).getUint32(8, true)
}
