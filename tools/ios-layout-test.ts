// Runs iOS's readers for layout values from a slot on the Mac (ios/tests/layout): the same as
// `bun run tools/ios-unit-test.ts layout`, kept so the old command still works.
//   bun run tools/ios-layout-test.ts
import { join } from "node:path"

const r = Bun.spawnSync(["bun", "run", join(import.meta.dir, "ios-unit-test.ts"), "layout"], { stdout: "inherit", stderr: "inherit" })
process.exit(r.exitCode ?? 1)
