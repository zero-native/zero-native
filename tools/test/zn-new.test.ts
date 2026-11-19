import { expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { className, newApp, title, znPaths } from "../zn-new"

const root = resolve(import.meta.dir, "../..")

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
    expect({ file: relative(app.dir, f), left: readFileSync(f, "utf8").match(/__[A-Z_]+__/g) }).toEqual({ file: relative(app.dir, f), left: null })
  }
  expect(all.map((f) => relative(app.dir, f))).toContain("android/app/src/main/java/com/example/myapp/MainActivity.kt")
  expect(statSync(join(app.dir, "android/gradlew")).mode & 0o111).not.toBe(0)
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
