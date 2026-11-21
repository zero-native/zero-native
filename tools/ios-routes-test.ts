// Runs iOS's route reading and deep link matching on the Mac (ios/tests/routes): the same as
// `bun run tools/ios-unit-test.ts routes`, kept so the old command still works. Needs bun run sample:js first.
//   bun run ios:routes-test
import { join } from "node:path"

const r = Bun.spawnSync(["bun", "run", join(import.meta.dir, "ios-unit-test.ts"), "routes"], { stdout: "inherit", stderr: "inherit" })
process.exit(r.exitCode ?? 1)
