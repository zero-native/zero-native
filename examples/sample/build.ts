// Builds the sample app for android/sample. The steps and options (--serial, --out, --map) are in tools/zn-build.ts.
// For live reload while you work, use `bun run dev` instead (tools/zn-dev.ts).
import { join } from "node:path"
import { znBuild } from "../../tools/zn-build"

await znBuild({
  appDir: import.meta.dir,
  name: "sample",
  assets: join(import.meta.dir, "../../android/sample/src/main/assets"),
})
