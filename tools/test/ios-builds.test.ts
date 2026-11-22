// Checks on the iOS builds' files that only a run on a phone would catch otherwise: the sample builds copy every asset
// folder the sample has (an app font that isn't in the app draws the system font, with only a log line), and every
// build of the runtime links the frameworks it uses.
import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "../..")
const read = (p: string) => readFileSync(join(root, p), "utf8")
const sampleFolders = readdirSync(join(root, "examples/sample/assets")).filter((n) => statSync(join(root, "examples/sample/assets", n)).isDirectory()).sort()

test("the sample has fonts, images and lottie folders (what the builds below copy)", () => {
  expect(sampleFolders).toEqual(["fonts", "images", "lottie"])
})

test("the CMake sample takes every asset folder of the bundle into the app", () => {
  const cmake = read("ios/CMakeLists.txt")
  const glob = /file\(GLOB_RECURSE asset_files CONFIGURE_DEPENDS ([^)]*)\)/.exec(cmake)![1]
  for (const d of sampleFolders) expect(glob).toContain(`"\${bundle_dir}/${d}/*"`)
})

test("the package sample's copy script takes every asset folder", () => {
  const script = /for d in ([a-z ]+); do/.exec(read("ios/SamplePackage/ZnSamplePackage.xcodeproj/project.pbxproj"))![1]
  expect(script.split(" ").sort()).toEqual(sampleFolders)
})

test("the app templates copy the whole bundle folder, fonts included", () => {
  expect(read("templates/app/ios/CMakeLists.txt")).toContain(`file(GLOB_RECURSE asset_files CONFIGURE_DEPENDS "\${bundle_dir}/*")`)
  expect(read("templates/app-ios-packages/ios/__APP_CLASS__.xcodeproj/project.pbxproj")).toContain(`cp -R \\"$src/.\\" \\"$dst/\\"`)
})

test("CoreMotion (useTilt) is linked by the CMake sample and the Swift package's runtime", () => {
  expect(read("ios/CMakeLists.txt")).toContain(`"-framework CoreMotion"`)
  expect(read("Package.swift")).toContain(`.linkedFramework("CoreMotion")`)
})

test("the CMake sample links every part fetch-firebase-apple.ts downloads", () => {
  const parts = /const PARTS = \[([^\]]+)\]/.exec(read("tools/fetch-firebase-apple.ts"))![1].match(/"([^"]+)"/g)!.map((p) => p.slice(1, -1))
  const linked = /set\(firebase_parts ([^)]+)\)/.exec(read("ios/CMakeLists.txt"))![1].trim().split(/\s+/)
  expect(linked).toEqual(parts)
})
