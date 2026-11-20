// swift-tools-version: 6.0
// zero-native for iOS as a Swift package (docs/publishing-plan.md §2.3). An app adds this repo as a package and picks
// ZnRuntime and the plugins it uses. The CMake build in ios/ (the sample, the core tests) stays as it is.
//
// Hermes, the first of these that applies:
// - ZN_HERMES_ZIP=<zip inside this repo>: that zip (the release workflow builds the sample against its new zip with it);
// - a fetched local copy (bun run tools/fetch-hermes-apple.ts release): what working on the framework uses;
// - the zip on this repo's GitHub Release hermes-<version> (.github/workflows/hermes-release.yml): what apps get. The
//   url and checksum come from that run's summary (docs/releasing.md); zeros mean it hasn't run yet.
// SwiftPM caches this file's result: after fetching or removing Hermes, reset the package caches (docs/releasing.md).
import Foundation
import PackageDescription

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().path
let localHermes = "ios/third_party/hermes/release/destroot/Library/Frameworks/universal/hermesvm.xcframework"
let hermes: Target
if let zip = ProcessInfo.processInfo.environment["ZN_HERMES_ZIP"], !zip.isEmpty {
  hermes = .binaryTarget(name: "hermesvm", path: zip)
} else if FileManager.default.fileExists(atPath: "\(root)/\(localHermes)/Info.plist") {
  hermes = .binaryTarget(name: "hermesvm", path: localHermes)
} else {
  hermes = .binaryTarget(
    name: "hermesvm",
    url: "https://github.com/zero-native/zero-native/releases/download/hermes-260318099.0.5/hermesvm.xcframework.zip",
    checksum: "0000000000000000000000000000000000000000000000000000000000000000")
}

/// Each plugin's iOS code (plugins/<folder>/ios) is the target and product ZnPlugin<Name>. [uses]: plugins whose types
/// it uses. The plugins that need Firebase or Lottie are packages of their own: ios/packages/firebase and
/// ios/packages/lottie (docs/releasing.md).
let plugins: [(name: String, folder: String, uses: [String])] = [
  ("AndroidPlayAuth", "android-play-auth", []),
  ("AppUpdates", "app-updates", []),
  ("DeviceInfo", "device-info", []),
  ("DocumentScanner", "document-scanner", []),
  ("ImageViewer", "image-viewer", []),
  ("Location", "location", []),
  ("Notifications", "notifications", []),
  ("Pdf", "pdf", []),
  ("Scanner", "scanner", []),
  ("WebView", "webview", []),
]

let swift5: [SwiftSetting] = [.swiftLanguageMode(.v5)]

var targets: [Target] = [
  hermes,
  // MMKV's C++ core (BSD-3), as core/CMakeLists.txt builds it: FORCE_POSIX, so Apple uses the same C++ API as Android.
  .target(
    name: "ZnMMKV",
    path: "core/third_party/mmkv/Core",
    exclude: [
      "CMakeLists.txt", "crc32/CMakeLists.txt", "cbridge", "fakeinclude",
      "MMKV_Android.cpp", "MMKVLog_Android.cpp", "InterProcessLock_Android.cpp", "InterProcessLock_Win32.cpp",
      "MemoryFile_Android.cpp", "MemoryFile_Linux.cpp", "MemoryFile_Win32.cpp", "ThreadLock_Win32.cpp",
    ],
    publicHeadersPath: "include",
    cxxSettings: [.define("FORCE_POSIX"), .headerSearchPath(".")],
    linkerSettings: [.linkedLibrary("z")]),
  // The shared C++ core (ARCHITECTURE.md §4) and its Hermes adapter.
  .target(
    name: "ZnCore",
    dependencies: ["ZnMMKV", "hermesvm"],
    path: "core",
    exclude: ["CMakeLists.txt", "tests", "third_party"],
    sources: ["src"],
    publicHeadersPath: "include",
    cxxSettings: [
      .define("FORCE_POSIX"),
      .headerSearchPath("third_party/jsi"),
      .headerSearchPath("third_party/hermes/include"),
    ]),
  // The Objective-C++ host: Hermes, the core and the main thread (what Swift sees: ZNHost.h).
  .target(
    name: "ZnHost",
    dependencies: ["ZnCore"],
    path: "ios/ZnRuntime/Host",
    exclude: ["ZnRuntime-Bridging-Header.h"],
    publicHeadersPath: ".",
    linkerSettings: [.linkedFramework("QuartzCore")]),
  // The Swift runtime, with zero-native's privacy manifest (the same file the CMake apps copy in their privacy bundle).
  .target(
    name: "ZnRuntime",
    dependencies: ["ZnHost"],
    path: "ios/ZnRuntime",
    exclude: ["Host", "ZnRuntime_Privacy.bundle/Info.plist"],
    sources: ["Swift"],
    resources: [.copy("ZnRuntime_Privacy.bundle/PrivacyInfo.xcprivacy")],
    swiftSettings: swift5),
]
for p in plugins {
  let deps: [Target.Dependency] = ["ZnRuntime"] + p.uses.map { .target(name: "ZnPlugin\($0)") }
  targets.append(.target(name: "ZnPlugin\(p.name)", dependencies: deps, path: "plugins/\(p.folder)/ios", swiftSettings: swift5))
}
var products: [Product] = [.library(name: "ZnRuntime", targets: ["ZnRuntime"])]
for p in plugins { products.append(.library(name: "ZnPlugin\(p.name)", targets: ["ZnPlugin\(p.name)"])) }

let package = Package(
  name: "ZeroNative",
  platforms: [.iOS(.v17)],
  products: products,
  targets: targets,
  cxxLanguageStandard: .cxx20
)
