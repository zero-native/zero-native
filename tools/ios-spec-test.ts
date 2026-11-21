// Runs iOS's parsers for template values read before they are drawn (grid row style, pinned rows, scroll commands) on
// the Mac (ios/tests/spec): the same as `bun run tools/ios-unit-test.ts spec`, kept so the old command still works.
//   bun run tools/ios-spec-test.ts
import { join } from "node:path"

const r = Bun.spawnSync([process.execPath, "run", join(import.meta.dir, "ios-unit-test.ts"), "spec"], { stdout: "inherit", stderr: "inherit" })
process.exit(r.exitCode ?? 1)
