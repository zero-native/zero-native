import { expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import { className, keepIosBlocks, newApp, title, znPaths } from "../zn-new"

const root = resolve(import.meta.dir, "../..")

/** [f] relative to [dir], with "/" on every OS (Windows' relative() gives "\\"). */
const rel = (dir: string, f: string) => relative(dir, f).split(sep).join("/")

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => (statSync(join(dir, e)).isDirectory() ? files(join(dir, e)) : [join(dir, e)]))
}

test("zn new fills every name in templates/app", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "zn-new-")), "my-app")
  const app = newApp(dir, { id: "com.example.myapp" })
  expect(app.name).toBe("my-app")
  const all = files(app.dir)
  for (const f of all) {
    if (f.endsWith(".jar")) continue
    expect({ file: rel(app.dir, f), left: readFileSync(f, "utf8").match(/__[A-Z_]+__/g) }).toEqual({ file: rel(app.dir, f), left: null })
  }
  expect(all.map((f) => rel(app.dir, f))).toContain("android/app/src/main/java/com/example/myapp/MainActivity.kt")
  // gradlew stays executable (NTFS has no exec bit, so not on Windows)
  if (process.platform !== "win32") expect(statSync(join(app.dir, "android/gradlew")).mode & 0o111).not.toBe(0)
  expect(readFileSync(join(app.dir, "ios/CMakeLists.txt"), "utf8")).toContain("add_executable(MyApp MACOSX_BUNDLE")
})

test("the template's Gradle wrapper, properties and plugin versions are the framework's", () => {
  const t = join(root, "templates/app/android")
  const a = join(root, "android")
  for (const f of ["gradlew", "gradlew.bat", "gradle/wrapper/gradle-wrapper.jar", "gradle/wrapper/gradle-wrapper.properties"]) {
    expect({ f, same: Buffer.compare(readFileSync(join(t, f)), readFileSync(join(a, f))) === 0 }).toEqual({ f, same: true })
  }
  expect(readFileSync(join(t, "gradle.properties"), "utf8").startsWith(readFileSync(join(a, "gradle.properties"), "utf8"))).toBe(true)
  const versions = (s: string) => Object.fromEntries([...s.matchAll(/id\("([^"]+)"\) version "([^"]+)"/g)].map((m) => [m[1], m[2]]))
  const framework = versions(readFileSync(join(a, "build.gradle.kts"), "utf8"))
  for (const [id, v] of Object.entries(versions(readFileSync(join(t, "build.gradle.kts"), "utf8")))) expect({ id, v }).toEqual({ id, v: framework[id]! })
})

test("zn new refuses bad names, a folder that isn't empty, and a folder inside zero-native", () => {
  const base = mkdtempSync(join(tmpdir(), "zn-new-"))
  expect(() => newApp(join(base, "a"), { name: "My App" })).toThrow(/app name/)
  expect(() => newApp(join(base, "b"), { id: "myapp" })).toThrow(/id "myapp"/)
  expect(() => newApp(join(root, "examples/x"))).toThrow(/inside zero-native/)
  newApp(join(base, "c"))
  expect(() => newApp(join(base, "c"))).toThrow(/not empty/)
  expect(className("my-app-2")).toBe("MyApp2")
  expect(title("my-app")).toBe("My App")
})

test("the app names zero-native by a relative path when they share a parent, else by its full path", () => {
  if (process.platform === "win32") return
  expect(znPaths("/home/me/code/my-app", "/home/me/code/zero-native")).toEqual({ znDir: "../zero-native", znDirSub: "../../zero-native" })
  expect(znPaths("/home/runner/work/_temp/ci-app", "/home/runner/work/zn/zn")).toEqual({ znDir: "../../zn/zn", znDirSub: "../../../zn/zn" })
  expect(znPaths("/tmp/T/my-app", "/opt/zero-native")).toEqual({ znDir: "/opt/zero-native", znDirSub: "/opt/zero-native" })
})

test("--ios packages: a plain Xcode project on the Swift package, no CMake, every name filled", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "zn-new-")), "pkg-app")
  const app = newApp(dir, { id: "com.example.pkgapp", ios: "packages" })
  expect(app.ios).toBe("packages")
  const all = files(app.dir).map((f) => rel(app.dir, f))
  expect(all).toContain("ios/PkgApp.xcodeproj/project.pbxproj")
  expect(all).toContain("ios/App/AppDelegate.swift")
  expect(all).not.toContain("ios/CMakeLists.txt")
  for (const f of files(app.dir)) {
    if (f.endsWith(".jar")) continue
    const text = readFileSync(f, "utf8")
    expect({ file: rel(app.dir, f), left: text.match(/__[A-Z_]+__|<!-- \/?ios:/g) }).toEqual({ file: rel(app.dir, f), left: null })
  }
  const pbx = readFileSync(join(app.dir, "ios/PkgApp.xcodeproj/project.pbxproj"), "utf8")
  expect(pbx).toContain("XCLocalSwiftPackageReference")
  expect(pbx).toContain("productName = ZnRuntime;")
  expect(pbx).toContain("PRODUCT_BUNDLE_IDENTIFIER = com.example.pkgapp;")
  expect(readFileSync(join(app.dir, "tools/ios.ts"), "utf8")).toContain("xcodebuild")
  const readme = readFileSync(join(app.dir, "README.md"), "utf8")
  expect(readme).toContain("ios/PkgApp.xcodeproj")
  expect(readme).not.toContain("CMakeLists.txt")
})

test("the default iOS host is still CMake, and its README has no packages text", () => {
  const app = newApp(join(mkdtempSync(join(tmpdir(), "zn-new-")), "cm-app"))
  expect(app.ios).toBe("cmake")
  expect(files(app.dir).map((f) => rel(app.dir, f))).toContain("ios/CMakeLists.txt")
  const readme = readFileSync(join(app.dir, "README.md"), "utf8")
  expect(readme).toContain("ios/CMakeLists.txt")
  expect(readme).not.toContain(".xcodeproj")
})

test("keepIosBlocks keeps one host's blocks without their markers", () => {
  const t = "a\n<!-- ios:cmake -->\nC\n<!-- /ios:cmake -->\n<!-- ios:packages -->\nP\n<!-- /ios:packages -->\nb\n"
  expect(keepIosBlocks(t, "cmake")).toBe("a\nC\nb\n")
  expect(keepIosBlocks(t, "packages")).toBe("a\nP\nb\n")
  // A Windows checkout (git's autocrlf) has "\r\n"
  const crlf = t.replaceAll("\n", "\r\n")
  expect(keepIosBlocks(crlf, "cmake")).toBe("a\r\nC\r\nb\r\n")
  expect(keepIosBlocks(crlf, "packages")).toBe("a\r\nP\r\nb\r\n")
})

test("an unknown --ios is refused", () => {
  expect(() => newApp(join(mkdtempSync(join(tmpdir(), "zn-new-")), "x-app"), { ios: "spm" as never })).toThrow(/cmake or packages/)
})
