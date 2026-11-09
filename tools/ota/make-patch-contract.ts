// A contract check between the server and the phone: makes a patch zip with the server's own code
// (server/src/patches.ts) from two real built bundle folders, for the Kotlin test ZnOtaPatchContractTest. The bundles are
// too big for the repo, so the files go to a folder you pick, and the test runs only when it is told where:
//   bun run tools/ota/make-patch-contract.ts <old bundle folder> <new bundle folder> <out folder>
//   ZN_PATCH_CONTRACT_DIR=<out folder> ./gradlew :runtime:testDebugUnitTest --tests '*ZnOtaPatchContractTest'
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildPatchZip, readBundleZip } from "../../server/src/patches"
import { zipBundleFiles } from "../updates/client"

const [oldDir, newDir, out] = process.argv.slice(2)
if (!oldDir || !newDir || !out) {
  console.error("usage: bun run tools/ota/make-patch-contract.ts <old bundle folder> <new bundle folder> <out folder>")
  process.exit(1)
}
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const from = readBundleZip(zipBundleFiles(oldDir))
const to = readBundleZip(zipBundleFiles(newDir))
const { zip, counts } = await buildPatchZip(to, from)
writeFileSync(join(out, "patch.zip"), zip)
cpSync(oldDir, join(out, "base"), { recursive: true })
cpSync(join(newDir, "zn-bundle.json"), join(out, "new-zn-bundle.json"))
console.log(`patch zip ${(zip.length / 1024).toFixed(1)} KB (copy ${counts.copy}, patch ${counts.patch}, whole ${counts.zip}) → ${out}`)
