// Downloads the Firebase Apple SDK (Google's prebuilt XCFrameworks) into ios/third_party/firebase/ (not in git). Only
// the parts zero-native's Firebase plugins use are kept: Analytics (with FirebaseCore and Installations), Crashlytics,
// Messaging, Remote Config and Performance. ios/CMakeLists.txt links them when this folder is there; without it, the app
// builds with Firebase off.
//
//   bun run tools/fetch-firebase-apple.ts
//
// The zip comes from the firebase-ios-sdk GitHub release and must match the SHA-256 pinned below (the release asset's
// digest). When upgrading, change VERSION and SHA256 together, and keep it close to the Android BoM's Firebase version
// (plugins/firebase-app/android/build.gradle.kts).
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs"
import { join } from "node:path"

const VERSION = "13.1.1"
const SHA256 = "eab04111b6b6ebd2bbd9264b452b2eec5be13703207f32f7cf10d9040e246b70"
/** The zip's top folders this repo uses. Each holds its own XCFrameworks and every dependency it needs. */
const PARTS = ["FirebaseAnalytics", "FirebaseCrashlytics", "FirebaseMessaging", "FirebaseRemoteConfig", "FirebasePerformance"]

const root = join(import.meta.dir, "..")
const outDir = join(root, "ios/third_party/firebase")
// The marker names the version and the parts, so a checkout made with fewer parts downloads again (it would build
// without the new ones).
const marker = join(outDir, `.version-${VERSION}-${partsTag(PARTS)}`)
if (existsSync(marker)) {
  console.log(`firebase ${VERSION} already in ${outDir}`)
  process.exit(0)
}

const url = `https://github.com/firebase/firebase-ios-sdk/releases/download/${VERSION}/Firebase.zip`
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const zip = join(outDir, "Firebase.zip")
console.log(`downloading ${url} (about 390 MB)`)
// curl, not fetch: the zip is too big to hold in memory comfortably.
const dl = Bun.spawnSync(["curl", "-fsSL", "--retry", "3", "-o", zip, url], { stdout: "inherit", stderr: "inherit" })
if (dl.exitCode !== 0) throw new Error("download failed")

const hasher = new Bun.CryptoHasher("sha256")
for await (const chunk of Bun.file(zip).stream()) hasher.update(chunk)
const got = hasher.digest("hex")
if (got !== SHA256) throw new Error(`SHA-256 mismatch: got ${got}, want ${SHA256}`)

const unzip = Bun.spawnSync(["unzip", "-q", zip, ...PARTS.map((p) => `Firebase/${p}/*`), "Firebase/Firebase.h", "Firebase/module.modulemap", "-d", outDir])
if (unzip.exitCode !== 0) throw new Error(`unzip failed: ${unzip.stderr.toString()}`)
rmSync(zip)
for (const name of readdirSync(join(outDir, "Firebase"))) renameSync(join(outDir, "Firebase", name), join(outDir, name))
rmSync(join(outDir, "Firebase"), { recursive: true, force: true })
await Bun.write(marker, "")
console.log(`firebase ${VERSION} → ${outDir}: ${readdirSync(outDir).filter((n) => !n.startsWith(".")).join(", ")}`)

/** A short tag for a list of parts (any order): the first 8 hex digits of their sorted names' SHA-256. */
function partsTag(parts: string[]): string {
  return new Bun.CryptoHasher("sha256").update([...parts].sort().join(",")).digest("hex").slice(0, 8)
}
