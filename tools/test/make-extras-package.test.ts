import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MAIN_URL, releaseManifest } from "../make-extras-package"

const manifest = readFileSync(join(import.meta.dir, "../../ios/ExtrasPackage/Package.swift"), "utf8")

test("the release copy depends on the main package by url and the exact version, named as SwiftPM names it", () => {
  const out = releaseManifest(manifest, "0.1.0")
  expect(out).toContain(`.package(url: "${MAIN_URL}", exact: "0.1.0")`)
  expect(out).not.toContain(`path: "../.."`)
  expect(out).not.toContain(`package: "ZeroNative"`)
  expect(out).toContain(`package: "zero-native"`)
  // The release header replaces the in-repo one (symlinks, paths), and the tools version stays the first line
  expect(out.split("\n")[0]).toBe("// swift-tools-version: 6.0")
  expect(out).toContain("at its release")
  expect(out).not.toContain("symlinks")
  // Firebase and Lottie keep their ranges: an app may add a newer one of either itself
  expect(out).toContain(`firebase-ios-sdk.git", from: "13.1.1"`)
  expect(out).toContain(`lottie-spm.git", from: "4.6.1"`)
})

test("a version that isn't x.y.z is refused", () => {
  expect(() => releaseManifest(manifest, "v0.1.0")).toThrow(/like 0.1.0/)
  expect(() => releaseManifest(manifest, "0.1")).toThrow(/like 0.1.0/)
})

test("the second package's lowest Firebase and Lottie versions are the ones the CMake build fetches", () => {
  const version = (tool: string) => /const VERSION = "([^"]+)"/.exec(readFileSync(join(import.meta.dir, "..", tool), "utf8"))![1]
  expect(manifest).toContain(`firebase-ios-sdk.git", from: "${version("fetch-firebase-apple.ts")}"`)
  expect(manifest).toContain(`lottie-spm.git", from: "${version("fetch-lottie-apple.ts")}"`)
})
