// Makes the Hermes zip the Swift package uses (Package.swift's `hermesvm` binary target; docs/publishing-plan.md §2.3).
// .github/workflows/hermes-release.yml runs it and uploads the zip to a GitHub Release; run it by hand to test.
//
//   bun run tools/make-hermes-zip.ts [--out <dir>]      default: build/hermes-zip
//
// From the release Hermes that tools/fetch-hermes-apple.ts downloads and checks (pinned version and SHA-256, with
// zero-native's privacy manifest in each iOS slice). Only the iOS device and simulator slices go in: Meta's
// XCFramework also has Mac Catalyst, tvOS and visionOS, which zero-native doesn't build for (67 MB unzipped against
// about 15). Hermes's MIT license goes in next to the slices. Prints the zip's SHA-256 as SwiftPM computes it.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

const root = resolve(import.meta.dir, "..")
const { values } = parseArgs({ options: { out: { type: "string" } } })
const out = resolve(values.out ?? join(root, "build/hermes-zip"))

function run(cmd: string[], cwd?: string): string {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed:\n${p.stderr.toString()}${p.stdout.toString()}`)
  return p.stdout.toString()
}

// The pinned release Hermes, downloaded and checked (again only when missing).
run(["bun", "run", join(root, "tools/fetch-hermes-apple.ts"), "release"], root)
const version = readdirSync(join(root, "ios/third_party/hermes/release"))
  .find((n) => n.startsWith(".version-"))
  ?.slice(".version-".length)
if (!version) throw new Error("no .version-* marker in ios/third_party/hermes/release")
const src = join(root, "ios/third_party/hermes/release/destroot/Library/Frameworks/universal/hermesvm.xcframework")
const license = join(root, "ios/third_party/hermes/release/LICENSE")

const slices = ["ios-arm64", "ios-arm64_x86_64-simulator"]
for (const s of slices) {
  const fw = join(src, s, "hermesvm.framework")
  if (!existsSync(join(fw, "PrivacyInfo.xcprivacy"))) throw new Error(`${fw} has no privacy manifest`)
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const xcf = join(out, "hermesvm.xcframework")
// xcodebuild writes a new Info.plist that lists only these two slices.
run(["xcodebuild", "-create-xcframework", ...slices.flatMap((s) => ["-framework", join(src, s, "hermesvm.framework")]), "-output", xcf])
cpSync(license, join(xcf, "LICENSE"))
// Exactly these two slices, each with its privacy manifest.
const plist = JSON.parse(run(["plutil", "-convert", "json", "-o", "-", join(xcf, "Info.plist")]))
const ids = (plist.AvailableLibraries as { LibraryIdentifier: string }[]).map((l) => l.LibraryIdentifier).sort()
if (JSON.stringify(ids) !== JSON.stringify([...slices].sort())) throw new Error(`the XCFramework has ${ids.join(", ")}`)
for (const s of slices) {
  if (!existsSync(join(xcf, s, "hermesvm.framework/PrivacyInfo.xcprivacy"))) throw new Error(`${s} lost its privacy manifest`)
}

const zip = join(out, "hermesvm.xcframework.zip")
// ditto keeps the framework's symlinks; no resource forks or extended attributes (no __MACOSX entries in the zip).
run(["ditto", "-c", "-k", "--norsrc", "--noextattr", "--noqtn", "--keepParent", "hermesvm.xcframework", zip], out)
const checksum = run(["swift", "package", "compute-checksum", zip]).trim()
if (!/^[0-9a-f]{64}$/.test(checksum)) throw new Error(`unexpected checksum output: ${checksum}`)

const mb = (statSync(zip).size / 1e6).toFixed(1)
console.log(`hermes ${version}: ${zip} (${mb} MB)`)
console.log(`version=${version}`)
console.log(`checksum=${checksum}`)
