// Makes the copy of the second Swift package (ios/ExtrasPackage: Firebase and Lottie) that goes in its own repo at a
// release (docs/publishing-plan.md §2.3, docs/releasing.md). In this repo the package's targets are symlinks to
// plugins/<name>/ios and it depends on the main package by path; the copy has the real files and depends on the main
// package by url and the release's version.
//
//   bun run tools/make-extras-package.ts --version 0.1.0 [--out <dir>]      default out: build/extras-package
//
// The output is the whole repo's content (Package.swift, Sources/, README.md, LICENSE, NOTICE). Nothing is pushed.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

const root = resolve(import.meta.dir, "..")
const src = join(root, "ios/ExtrasPackage")
export const MAIN_URL = "https://github.com/zero-native/zero-native.git"
const PATH_DEP = `.package(name: "ZeroNative", path: "../..")`

/**
 * Package.swift for the copy: the main package by url and [version], everything else unchanged. A url dependency
 * can't be given a name (SwiftPM 6): it is known by the url's last part, "zero-native", so the products that name the
 * path dependency's "ZeroNative" change to that.
 */
export function releaseManifest(manifest: string, version: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`--version must be like 0.1.0, got "${version}"`)
  if (!manifest.includes(PATH_DEP)) throw new Error(`ios/ExtrasPackage/Package.swift has no ${PATH_DEP}`)
  const tools = manifest.split("\n")[0]!
  if (!tools.startsWith("// swift-tools-version:")) throw new Error("Package.swift must start with its swift-tools-version line")
  const body = manifest.slice(manifest.indexOf("import PackageDescription"))
  const header = [
    tools,
    "// zero-native's iOS plugins that need Google's or Airbnb's SDKs (Firebase, Lottie), as a package of their own so an",
    "// app without them never downloads those SDKs. It depends on zero-native at exactly this repo's version: add both",
    "// at the same version. Made from the zero-native repo (ios/ExtrasPackage, plugins/<name>/ios) at its release",
    `// ${version}: change the code there, not here.`,
  ].join("\n")
  return `${header}\n${body}`
    .replace(PATH_DEP, `.package(url: "${MAIN_URL}", exact: "${version}")`)
    .replaceAll(`package: "ZeroNative"`, `package: "zero-native"`)
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { version: { type: "string" }, out: { type: "string" } } })
  if (!values.version) throw new Error("--version <x.y.z> is required (the zero-native release this copy depends on)")
  const out = resolve(values.out ?? join(root, "build/extras-package"))
  rmSync(out, { recursive: true, force: true })
  mkdirSync(join(out, "Sources"), { recursive: true })

  const manifest = readFileSync(join(src, "Package.swift"), "utf8")
  writeFileSync(join(out, "Package.swift"), releaseManifest(manifest, values.version))
  for (const name of readdirSync(join(src, "Sources")).sort()) {
    const link = join(src, "Sources", name)
    if (!lstatSync(link).isSymbolicLink()) throw new Error(`${link} should be a symlink to plugins/<name>/ios`)
    const target = realpathSync(link)
    // Only the Swift sources: the copy is a SwiftPM target, nothing else from the plugin's ios/ folder.
    mkdirSync(join(out, "Sources", name))
    for (const f of readdirSync(target).sort()) {
      if (!f.endsWith(".swift")) throw new Error(`${target}/${f}: only .swift files are expected in a plugin's ios/ folder`)
      cpSync(join(target, f), join(out, "Sources", name, f))
    }
  }
  cpSync(join(src, "README.release.md"), join(out, "README.md"))
  for (const f of ["LICENSE", "NOTICE"]) cpSync(join(root, f), join(out, f))
  if (!existsSync(join(out, "Sources/ZnPluginFirebaseApp"))) throw new Error("no Sources/ZnPluginFirebaseApp in the copy")
  console.log(`extras package for zero-native ${values.version} → ${out}`)
}
