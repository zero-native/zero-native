// Makes the copies of the plugin Swift packages (ios/packages/<name>: firebase, lottie) that go in their own repos at
// a release (docs/publishing-plan.md §2.3, docs/releasing.md). In this repo each package's targets are symlinks to
// plugins/<name>/ios and it depends on the main package by path; each copy has the real files and depends on the main
// package by url and the release's version.
//
//   bun run tools/make-plugin-packages.ts --version 0.1.0 [--out <dir>]      default out: build/plugin-packages
//
// Writes <out>/<name>/ for each package: the whole content of its repo (Package.swift, Sources/, README.md, LICENSE,
// NOTICE). Nothing is pushed.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

const root = resolve(import.meta.dir, "..")
export const PACKAGES_DIR = join(root, "ios/packages")
export const MAIN_URL = "https://github.com/zero-native/zero-native.git"
const PATH_DEP = `.package(name: "ZeroNative", path: "../../..")`

/** The packages: each folder of ios/packages with a Package.swift. Its repo is zero-native-<folder>. */
export function pluginPackages(): string[] {
  return readdirSync(PACKAGES_DIR).filter((n) => existsSync(join(PACKAGES_DIR, n, "Package.swift"))).sort()
}

/**
 * Package.swift for a copy: the main package by url and [version], a header that is true in the copy's repo,
 * everything else unchanged. A url dependency can't be given a name (SwiftPM 6): it is known by the url's last part,
 * "zero-native", so the products that name the path dependency's "ZeroNative" change to that.
 */
export function releaseManifest(manifest: string, version: string, name: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`--version must be like 0.1.0, got "${version}"`)
  if (!manifest.includes(PATH_DEP)) throw new Error(`ios/packages/${name}/Package.swift has no ${PATH_DEP}`)
  const [tools, line2] = manifest.split("\n")
  if (!tools!.startsWith("// swift-tools-version:")) throw new Error("Package.swift must start with its swift-tools-version line")
  // What the package holds, from its own header ("Firebase plugins", "Lottie plugin"): written in one place only.
  const what = /^\/\/ zero-native's (.+?) for iOS/.exec(line2 ?? "")?.[1]
  if (!what) throw new Error(`ios/packages/${name}/Package.swift: line 2 must start "// zero-native's <what> for iOS"`)
  const body = manifest.slice(manifest.indexOf("import PackageDescription"))
  const header = [
    tools,
    `// zero-native's ${what} for iOS, as a Swift package of their own so an app without that SDK never downloads it.`,
    "// It depends on zero-native at exactly this repo's version: add both at the same version.",
    `// Made from the zero-native repo (ios/packages/${name}, plugins/<name>/ios) at its release ${version}: change the`,
    "// code there, not here.",
  ].join("\n")
  return `${header}\n${body}`
    .replace(PATH_DEP, `.package(url: "${MAIN_URL}", exact: "${version}")`)
    .replaceAll(`package: "ZeroNative"`, `package: "zero-native"`)
}

/** Writes the copy of package [name] into [out]. */
export function makeCopy(name: string, version: string, out: string): void {
  const src = join(PACKAGES_DIR, name)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(join(out, "Sources"), { recursive: true })
  writeFileSync(join(out, "Package.swift"), releaseManifest(readFileSync(join(src, "Package.swift"), "utf8"), version, name))
  for (const target of readdirSync(join(src, "Sources")).sort()) {
    const link = join(src, "Sources", target)
    if (!lstatSync(link).isSymbolicLink()) throw new Error(`${link} should be a symlink to plugins/<name>/ios`)
    const dir = realpathSync(link)
    // Only the Swift sources: the copy is a SwiftPM target, nothing else from the plugin's ios/ folder.
    mkdirSync(join(out, "Sources", target))
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith(".swift")) throw new Error(`${dir}/${f}: only .swift files are expected in a plugin's ios/ folder`)
      cpSync(join(dir, f), join(out, "Sources", target, f))
    }
  }
  cpSync(join(src, "README.release.md"), join(out, "README.md"))
  for (const f of ["LICENSE", "NOTICE"]) cpSync(join(root, f), join(out, f))
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { version: { type: "string" }, out: { type: "string" } } })
  if (!values.version) throw new Error("--version <x.y.z> is required (the zero-native release these copies depend on)")
  const out = resolve(values.out ?? join(root, "build/plugin-packages"))
  for (const name of pluginPackages()) {
    makeCopy(name, values.version, join(out, name))
    console.log(`zero-native-${name} for zero-native ${values.version} → ${join(out, name)}`)
  }
}
