// Runs iOS's OTA rules on the Mac (ios/tests/ota): the same as `bun run tools/ios-unit-test.ts ota`, kept so the
// old command still works.
//   bun run ios:ota-test
import { join } from "node:path"

const r = Bun.spawnSync(["bun", "run", join(import.meta.dir, "ios-unit-test.ts"), "ota"], { stdout: "inherit", stderr: "inherit" })
process.exit(r.exitCode ?? 1)
