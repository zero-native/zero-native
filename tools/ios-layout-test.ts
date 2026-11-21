// Runs iOS's readers for layout values from a slot on the Mac: builds ios/tests/layout/main.swift with
// ZnDynamicValues.swift, Registry.swift and Readers.swift (no SwiftUI or UIKit in any of them) and runs it.
//   bun run tools/ios-layout-test.ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const work = mkdtempSync(join(tmpdir(), "zn-ios-layout-"))
const run = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" })
  if (r.exitCode !== 0) {
    rmSync(work, { recursive: true, force: true })
    process.exit(r.exitCode ?? 1)
  }
}
try {
  const swift = "ios/ZnRuntime/Swift"
  run(["xcrun", "swiftc", "-O", "-o", join(work, "layout-tests"), `${swift}/Registry.swift`, `${swift}/Readers.swift`,
    `${swift}/ZnDynamicValues.swift`, "ios/tests/layout/main.swift"])
  run([join(work, "layout-tests")])
} finally {
  rmSync(work, { recursive: true, force: true })
}
