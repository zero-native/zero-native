// iOS's route reading and deep link matching (tools/ios-routes-test.ts), in `bun run test` on a Mac with Xcode and
// the sample built (bun run sample:js). Skipped elsewhere: it compiles Swift.
import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "../..")
const routes = join(root, "android/sample/src/main/assets/main.zn.ui.json")
const swift = process.platform === "darwin" && Bun.spawnSync(["xcrun", "--find", "swiftc"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0

test.skipIf(!swift || !existsSync(routes))("iOS reads the sample's routes and matches deep links as Android does (ios/tests/routes)", () => {
  const r = Bun.spawnSync(["bun", "run", join(root, "tools/ios-routes-test.ts")], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const out = r.stdout.toString() + r.stderr.toString()
  expect({ exit: r.exitCode, out: out.includes("tests passed") ? "passed" : out }).toEqual({ exit: 0, out: "passed" })
}, 120_000)
