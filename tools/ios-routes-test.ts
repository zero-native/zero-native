// Runs iOS's route reading and deep link matching on the Mac: builds ios/tests/routes/main.swift with ZnRoutes.swift
// (Foundation only) and runs it against the sample's built main.zn.ui.json (bun run sample:js makes it).
//   bun run ios:routes-test
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const routes = join(root, "android/sample/src/main/assets/main.zn.ui.json")
if (!existsSync(routes)) {
  console.error(`no ${routes}: run bun run sample:js first`)
  process.exit(1)
}
const work = mkdtempSync(join(tmpdir(), "zn-ios-routes-"))
const run = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" })
  if (r.exitCode !== 0) {
    rmSync(work, { recursive: true, force: true })
    process.exit(r.exitCode ?? 1)
  }
}
try {
  run(["xcrun", "swiftc", "-O", "-o", join(work, "routes-tests"), "ios/ZnRuntime/Swift/ZnRoutes.swift", "ios/tests/routes/main.swift"])
  run([join(work, "routes-tests"), routes])
} finally {
  rmSync(work, { recursive: true, force: true })
}
