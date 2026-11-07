// Builds the sample app for android/sample. The steps and options (--serial, --out, --map) are in tools/zn-build.ts.
// For live reload while you work, use `bun run dev` instead (tools/zn-dev.ts).
import { copyFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { znBuild } from "../../tools/zn-build"

// The offers feed (src/offers.ts) reads test-kit/offers-data.json: real offers, not in git. A fresh clone gets the
// made-up example instead, so the sample builds anywhere.
const testKit = join(import.meta.dir, "../../test-kit")
if (!existsSync(join(testKit, "offers-data.json"))) {
  copyFileSync(join(testKit, "offers-data.example.json"), join(testKit, "offers-data.json"))
  console.log("sample: test-kit/offers-data.json was missing; using test-kit/offers-data.example.json")
}

await znBuild({
  appDir: import.meta.dir,
  name: "sample",
  assets: join(import.meta.dir, "../../android/sample/src/main/assets"),
})
