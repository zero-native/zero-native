// iOS's Mac unit tests (tools/ios-unit-test.ts, every ios/tests/<suite>), one test per suite, in `bun run test` on a
// Mac with Xcode. Skipped elsewhere (they compile Swift), and a suite whose input isn't built yet (the routes suite
// reads the sample's main.zn.ui.json: bun run sample:js) is skipped too.
import { expect, test } from "bun:test"
import { join } from "node:path"
import { hasSwiftc, iosSuiteMissing, iosSuites } from "../ios-unit-test"

const root = join(import.meta.dir, "../..")
const swift = hasSwiftc()

test("ios/tests has the suites the runner finds", () => {
  expect(iosSuites()).toEqual(expect.arrayContaining(["layout", "ota", "routes"]))
})

for (const suite of iosSuites()) {
  test.skipIf(!swift || iosSuiteMissing(suite).missing.length > 0)(`iOS unit suite ios/tests/${suite} passes on the Mac`, () => {
    const r = Bun.spawnSync([process.execPath, "run", join(root, "tools/ios-unit-test.ts"), suite], { cwd: root, stdout: "pipe", stderr: "pipe" })
    const out = r.stdout.toString() + r.stderr.toString()
    expect({ exit: r.exitCode, out: out.includes("1 suite(s) passed") ? "passed" : out }).toEqual({ exit: 0, out: "passed" })
  }, 180_000)
}
