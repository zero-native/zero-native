// Downloads Hermes for Apple platforms (iOS device + simulator, macOS) into ios/third_party/hermes/ (not in git).
// Same Hermes release as android/runtime (com.facebook.hermes:hermes-android) and the hermesc in node_modules:
// bytecode, JSI headers and the engine must all come from one release (core/third_party/jsi/README.md).
//
//   bun run tools/fetch-hermes-apple.ts            debug build (asserts on; for everyday work and tests)
//   bun run tools/fetch-hermes-apple.ts release    release build
//
// The tarball comes from Maven Central (which redirects to Meta's repo.reactnative.dev) and must match the SHA-256
// pinned below, from Maven Central's own .sha256 files. When upgrading Hermes, change VERSION and both hashes together
// with android/runtime's hermes-android, hermes-compiler in package.json and core/third_party/jsi.
//
// Meta's hermesvm.framework has no privacy manifest, and Apple wants one from Hermes (it is on Apple's list of SDKs
// that need one). This tool writes it into every iOS slice, also when Hermes was fetched before, so the app embeds
// (and signs) the framework with it.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const VERSION = "260318099.0.5"
const SHA256: Record<string, string> = {
  debug: "c92c147a668e3349b041f27e457859e80d50512dc0aa4d9241987b4c64675625",
  release: "4e137490ffdf5b145bd629c5cabdfe9aee54573308d7c357bc3300ac78d64507",
}

const flavor = process.argv[2] ?? "debug"
if (!(flavor in SHA256)) throw new Error(`unknown flavor "${flavor}" (debug or release)`)

const root = join(import.meta.dir, "..")
const outDir = join(root, "ios/third_party/hermes", flavor)
const marker = join(outDir, `.version-${VERSION}`)
/**
 * Hermes's own required-reason APIs (`nm -u hermesvm`: stat, fstat, for the bytecode files it maps, inside the app's
 * container: C617.1). It collects nothing and tracks nothing.
 */
const PRIVACY = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>NSPrivacyTracking</key>
\t<false/>
\t<key>NSPrivacyTrackingDomains</key>
\t<array/>
\t<key>NSPrivacyCollectedDataTypes</key>
\t<array/>
\t<key>NSPrivacyAccessedAPITypes</key>
\t<array>
\t\t<dict>
\t\t\t<key>NSPrivacyAccessedAPIType</key>
\t\t\t<string>NSPrivacyAccessedAPICategoryFileTimestamp</string>
\t\t\t<key>NSPrivacyAccessedAPITypeReasons</key>
\t\t\t<array>
\t\t\t\t<string>C617.1</string>
\t\t\t</array>
\t\t</dict>
\t</array>
</dict>
</plist>
`

/** Writes PRIVACY into each iOS slice's hermesvm.framework (device, simulator, Mac Catalyst). */
function writePrivacyManifests(): void {
  const xcf = join(outDir, "destroot/Library/Frameworks/universal/hermesvm.xcframework")
  let n = 0
  for (const slice of readdirSync(xcf)) {
    if (!slice.startsWith("ios-")) continue
    const fw = join(xcf, slice, "hermesvm.framework")
    if (!existsSync(fw)) continue
    writeFileSync(join(fw, "PrivacyInfo.xcprivacy"), PRIVACY)
    n++
  }
  console.log(`hermes (${flavor}): privacy manifest in ${n} iOS slice(s)`)
}

if (existsSync(marker)) {
  console.log(`hermes ${VERSION} (${flavor}) already in ${outDir}`)
  writePrivacyManifests()
  process.exit(0)
}

const url =
  `https://repo1.maven.org/maven2/com/facebook/hermes/hermes-ios/${VERSION}/` +
  `hermes-ios-${VERSION}-hermes-ios-${flavor}.tar.gz`
console.log(`downloading ${url}`)
const res = await fetch(url, { redirect: "follow" })
if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
const bytes = new Uint8Array(await res.arrayBuffer())
const got = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
if (got !== SHA256[flavor]) throw new Error(`SHA-256 mismatch: got ${got}, want ${SHA256[flavor]}`)

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const tarball = join(outDir, "hermes.tar.gz")
await Bun.write(tarball, bytes)
// The tarball holds destroot/{include,Library/Frameworks/{universal/hermesvm.xcframework,macosx/hermesvm.framework},bin}.
const tar = Bun.spawnSync(["tar", "-xzf", tarball, "-C", outDir, "destroot/include", "destroot/Library", "LICENSE"])
if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`)
rmSync(tarball)
writePrivacyManifests()
await Bun.write(marker, "")
console.log(`hermes ${VERSION} (${flavor}) → ${outDir} (${(bytes.length / 1e6).toFixed(1)} MB download)`)
