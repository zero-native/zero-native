// iOS's parsers for template values read before they are drawn (tools/ios-spec-test.ts), in `bun run test` on a Mac
// with Xcode. Skipped elsewhere: it compiles Swift.
import { expect, test } from "bun:test"
import { join } from "node:path"

const root = join(import.meta.dir, "../..")
const swift = process.platform === "darwin" && Bun.spawnSync(["xcrun", "--find", "swiftc"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0

test.skipIf(!swift)("iOS reads grid row styles, pinned rows and scroll commands as Android does (ios/tests/spec)", () => {
  const r = Bun.spawnSync(["bun", "run", join(root, "tools/ios-spec-test.ts")], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const out = r.stdout.toString() + r.stderr.toString()
  expect({ exit: r.exitCode, out: out.includes("checks passed") ? "passed" : out }).toEqual({ exit: 0, out: "passed" })
}, 120_000)
