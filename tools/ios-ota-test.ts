// Runs iOS's OTA rules on the Mac: builds ios/tests/ota/main.swift with ZnOtaRules.swift and ZnOtaInstall.swift (no
// UIKit in either) and runs it against the CLI's signature fixture and a zip made the CLI's way.
//   bun run ios:ota-test
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const work = mkdtempSync(join(tmpdir(), "zn-ios-ota-"))
const run = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" })
  if (r.exitCode !== 0) {
    rmSync(work, { recursive: true, force: true })
    process.exit(r.exitCode ?? 1)
  }
}
try {
  run(["bun", "run", "ios/tests/ota/make-fixture.ts", join(work, "fixture")])
  const swift = "ios/ZnRuntime/Swift"
  run(["xcrun", "swiftc", "-O", "-o", join(work, "ota-tests"), `${swift}/ZnOtaRules.swift`, `${swift}/ZnOtaInstall.swift`, "ios/tests/ota/main.swift"])
  run([join(work, "ota-tests"), "android/runtime/src/test/resources/ota-signature-fixture.json", join(work, "fixture")])
} finally {
  rmSync(work, { recursive: true, force: true })
}
