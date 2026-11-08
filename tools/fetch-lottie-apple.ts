// Downloads lottie-ios (Airbnb's prebuilt static XCFramework) into ios/third_party/lottie/ (not in git), for the lottie
// plugin's iOS side (plugins/lottie/ios). ios/CMakeLists.txt links it when it is there; without it the app builds and
// `<LottieView>` shows nothing (the plugin answers "failed").
//
//   bun run tools/fetch-lottie-apple.ts
//
// The zip comes from the lottie-ios GitHub release and must match the SHA-256 pinned below (the release asset's digest).
// lottie-react-native 7.x uses lottie-ios 4.5+ on iOS, so the same files draw the same.
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"

const VERSION = "4.6.1"
const SHA256 = "88c63fefc9dc6f759fbe6da5292110170a16e1cbf3918c0205c7a7b26ae2eb4a"

const root = join(import.meta.dir, "..")
const outDir = join(root, "ios/third_party/lottie")
const marker = join(outDir, `.version-${VERSION}`)
if (existsSync(marker)) {
  console.log(`lottie-ios ${VERSION} already in ${outDir}`)
  process.exit(0)
}

const url = `https://github.com/airbnb/lottie-ios/releases/download/${VERSION}/Lottie-Static.xcframework.zip`
console.log(`downloading ${url}`)
const res = await fetch(url, { redirect: "follow" })
if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
const bytes = new Uint8Array(await res.arrayBuffer())
const got = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
if (got !== SHA256) throw new Error(`SHA-256 mismatch: got ${got}, want ${SHA256}`)

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const zip = join(outDir, "lottie.zip")
await Bun.write(zip, bytes)
const unzip = Bun.spawnSync(["unzip", "-q", zip, "-d", outDir])
if (unzip.exitCode !== 0) throw new Error(`unzip failed: ${unzip.stderr.toString()}`)
rmSync(zip)
await Bun.write(marker, "")
console.log(`lottie-ios ${VERSION} → ${outDir} (${(bytes.length / 1e6).toFixed(1)} MB download)`)
