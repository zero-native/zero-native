import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MAIN_URL, PACKAGES_DIR, pluginPackages, releaseManifest } from "../make-plugin-packages"

const manifest = (name: string) => readFileSync(join(PACKAGES_DIR, name, "Package.swift"), "utf8")
const pinned = (tool: string) => /const VERSION = "([^"]+)"/.exec(readFileSync(join(import.meta.dir, "..", tool), "utf8"))![1]

test("one package per outside SDK: firebase and lottie", () => {
  expect(pluginPackages()).toEqual(["firebase", "lottie"])
})

test("a release copy depends on the main package by url and the exact version, named as SwiftPM names it", () => {
  for (const name of pluginPackages()) {
    const out = releaseManifest(manifest(name), "0.1.0", name)
    expect(out).toContain(`.package(url: "${MAIN_URL}", exact: "0.1.0")`)
    expect(out).not.toContain(`path: "../../.."`)
    expect(out).not.toContain(`package: "ZeroNative"`)
    expect(out).toContain(`package: "zero-native"`)
    // The release header replaces the in-repo one (symlinks, paths); the tools version stays the first line
    expect(out.split("\n")[0]).toBe("// swift-tools-version: 6.0")
    expect(out).toContain(`at its release 0.1.0`)
    expect(out).not.toContain("symlinks")
  }
})

test("a release header names what the package holds", () => {
  expect(releaseManifest(manifest("firebase"), "0.1.0", "firebase")).toContain("zero-native's Firebase plugins for iOS")
  expect(releaseManifest(manifest("lottie"), "0.1.0", "lottie")).toContain("zero-native's Lottie plugin for iOS")
})

test("a version that isn't x.y.z is refused", () => {
  expect(() => releaseManifest(manifest("lottie"), "v0.1.0", "lottie")).toThrow(/like 0.1.0/)
  expect(() => releaseManifest(manifest("lottie"), "0.1", "lottie")).toThrow(/like 0.1.0/)
})

test("the lowest Firebase and Lottie versions are the ones the CMake build fetches, and each package has only its SDK", () => {
  const firebase = manifest("firebase"), lottie = manifest("lottie")
  expect(firebase).toContain(`firebase-ios-sdk.git", from: "${pinned("fetch-firebase-apple.ts")}"`)
  expect(lottie).toContain(`lottie-spm.git", from: "${pinned("fetch-lottie-apple.ts")}"`)
  expect(firebase).not.toContain("lottie-spm")
  expect(lottie).not.toContain("firebase-ios-sdk")
})
