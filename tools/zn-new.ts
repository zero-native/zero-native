// `zn new <dir>`: starts an app outside this repo from templates/app (docs/guide-notes.md §34).
//
//   bun run tools/zn.ts new ../my-app
//   zn new ../my-app --name my-app --id com.example.myapp
//
// --name: the app's name: the JS bundle's app name (keep it the same as the OTA app name), the package name and the
//         link scheme (my-app://app/about). a-z, 0-9 and -, starting with a letter. Default: the folder's name.
// --id:   the Android application id and the iOS bundle id. Default: com.example.<name without dashes>.
// --ios:  the iOS host. `cmake` (default): an Xcode project made by CMake that compiles zero-native's sources in.
//         `packages`: a plain Xcode project on zero-native's Swift package (Package.swift; templates/app-ios-packages).
//
// The app points at this zero-native checkout (package.json, android/gradle.properties, ios/CMakeLists.txt,
// tools/ios.ts), so it works before the packages are published. The path is relative when the two folders share a
// parent below the top of the disk (../zero-native), else absolute. Move one of them, and change the path.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path"
import { parseArgs } from "node:util"

// Real paths: macOS's temp folder (/var/...) is a link to /private/var/..., and CMake and Gradle read the real one.
const root = realpathSync(resolve(import.meta.dir, ".."))
const template = join(root, "templates/app")
/** The Swift package iOS host: replaces templates/app's ios/CMakeLists.txt and tools/ios.ts. */
const packagesTemplate = join(root, "templates/app-ios-packages")

/** Files copied as they are (no names filled in). */
const BINARY = /\.(jar|png|jpg|jpeg|webp|gif|ttf|otf|zip)$/i

export type IosHost = "cmake" | "packages"

export interface NewAppOptions {
  name?: string
  id?: string
  /** The iOS host (default "cmake"). */
  ios?: IosHost
}

export interface NewApp {
  dir: string
  name: string
  id: string
  /** The zero-native folder, as the app's files name it: relative to the app's folder, or absolute. */
  znDir: string
  ios: IosHost
}

/** Keeps the `<!-- ios:<host> -->` blocks of [host] (without the markers) and drops the other host's. */
export function keepIosBlocks(text: string, host: IosHost): string {
  return text.replace(/<!-- ios:(cmake|packages) -->\n([\s\S]*?)<!-- \/ios:\1 -->\n/g, (_m, h: string, body: string) => (h === host ? body : ""))
}

const NAME = /^[a-z][a-z0-9-]{0,63}$/
// Letters and digits only: Android ids forbid "-", and iOS bundle ids forbid "_".
const ID = /^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)+$/

/** "my-app" → "MyApp": the Xcode project, target and Swift module. */
export function className(name: string): string {
  return name.split("-").filter(Boolean).map((p) => p[0]!.toUpperCase() + p.slice(1)).join("")
}

/** "my-app" → "My App": what the phone shows under the icon. */
export function title(name: string): string {
  return name.split("-").filter(Boolean).map((p) => p[0]!.toUpperCase() + p.slice(1)).join(" ")
}

/**
 * How the app's files name zero-native: [znDir] from the app's folder, [znDirSub] from its android/ and ios/ folders.
 * Always with "/" (Gradle, CMake and Bun read them on every OS). Relative when the two share a parent other than the
 * top of the disk (../zero-native), else absolute.
 */
export function znPaths(appDir: string, znRoot: string): { znDir: string; znDirSub: string } {
  const top = (p: string) => relative(parse(p).root, p).split(sep)[0]
  const rel = relative(appDir, znRoot)
  const shared = parse(appDir).root === parse(znRoot).root && top(appDir) === top(znRoot) && !isAbsolute(rel)
  const znDir = (shared ? rel || "." : znRoot).split(sep).join("/")
  return { znDir, znDirSub: shared ? `../${znDir}` : znDir }
}

/** Makes the app in [dirArg]. Throws with a message for the user when something is wrong. */
export function newApp(dirArg: string, opts: NewAppOptions = {}): NewApp {
  let dir = resolve(dirArg)
  const name = opts.name ?? basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+|-+$/g, "")
  if (!NAME.test(name)) throw new Error(`app name "${name}": use a-z, 0-9 and -, starting with a letter (--name)`)
  const id = opts.id ?? `com.example.${name.replace(/-/g, "")}`
  if (!ID.test(id)) throw new Error(`id "${id}": use parts of a-z, A-Z and 0-9, each starting with a letter, joined by dots (--id; no "_", which iOS forbids, and no "-", which Android forbids)`)
  const ios: IosHost = opts.ios ?? "cmake"
  if (ios !== "cmake" && ios !== "packages") throw new Error(`--ios "${ios}": use cmake or packages`)
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`${dir} is not empty`)
  // The closest folder that exists, as a real path: is the app inside zero-native?
  let probe = dir
  while (!existsSync(probe)) probe = dirname(probe)
  const real = join(realpathSync(probe), relative(probe, dir))
  if (real === root || real.startsWith(root + sep)) {
    throw new Error(`${dir} is inside zero-native (${root}). zn new makes an app outside it: pick a folder elsewhere.`)
  }
  mkdirSync(dir, { recursive: true })
  dir = realpathSync(dir)

  const { znDir, znDirSub } = znPaths(dir, root)
  const tokens: Record<string, string> = {
    __APP_NAME__: name,
    __APP_TITLE__: title(name),
    __APP_CLASS__: className(name),
    __APP_ID__: id,
    __APP_PACKAGE_DIR__: id.split(".").join("/"),
    __ZN_DIR__: znDir,
    __ZN_DIR_SUB__: znDirSub,
  }
  const fill = (s: string) => s.replace(/__(APP_NAME|APP_TITLE|APP_CLASS|APP_ID|APP_PACKAGE_DIR|ZN_DIR_SUB|ZN_DIR)__/g, (t) => tokens[t]!)

  // The packages host has its own Xcode project and tools/ios.ts; the CMake ones are left out.
  const cmakeOnly = new Set([join(template, "ios/CMakeLists.txt"), join(template, "tools/ios.ts")])
  const copy = (from: string, to: string) => {
    for (const entry of readdirSync(from)) {
      const src = join(from, entry)
      if (ios === "packages" && cmakeOnly.has(src)) continue
      const dst = join(to, fill(entry))
      const st = statSync(src)
      if (st.isDirectory()) {
        copy(src, dst)
        continue
      }
      mkdirSync(dirname(dst), { recursive: true })
      if (BINARY.test(entry)) copyFileSync(src, dst)
      else writeFileSync(dst, keepIosBlocks(fill(readFileSync(src, "utf8")), ios))
      chmodSync(dst, st.mode & 0o777) // gradlew stays executable
    }
  }
  copy(template, dir)
  if (ios === "packages") copy(packagesTemplate, dir)
  return { dir, name, id, znDir, ios }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { name: { type: "string" }, id: { type: "string" }, ios: { type: "string" }, help: { type: "boolean", short: "h" } },
  })
  if (values.help || positionals.length !== 1) {
    console.log("usage: zn new <dir> [--name <app name>] [--id <application / bundle id>] [--ios cmake|packages]")
    process.exit(values.help ? 0 : 1)
  }
  let app: NewApp
  try {
    app = newApp(positionals[0]!, { name: values.name, id: values.id, ios: values.ios as IosHost | undefined })
  } catch (e) {
    console.error(`zn new: ${(e as Error).message}`)
    process.exit(1)
  }
  const shown = positionals[0]!
  console.log(`zn new: made ${app.name} (${app.id}) in ${shown}, using zero-native at ${app.znDir}`)
  if (!existsSync(join(root, "node_modules"))) console.log(`\nzero-native has no node_modules yet. Once, in ${root}:\n  bun install`)
  console.log(`
Next:
  cd ${shown}
  bun install
  bun run ios        iOS simulator (needs Xcode 26${app.ios === "cmake" ? " and CMake" : "; the host is ios/" + className(app.name) + ".xcodeproj"})
  bun run android    a phone or emulator on adb (needs the Android SDK)

More in ${shown}/README.md.`)
}
