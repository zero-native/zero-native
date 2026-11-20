// swift-tools-version: 6.0
// zero-native's Lottie plugin for iOS, as a Swift package of its own (docs/publishing-plan.md §2.3), so an app without
// Lottie never downloads it. The main package (../../../Package.swift) has the runtime and the plugins that need no
// outside SDK; ios/packages/firebase has Firebase.
//
// The code stays in plugins/lottie/ios, where the CMake builds compile it: Sources/ZnPluginLottie is a symlink to that
// folder. Here the package depends on the main one by path; the copy apps get (its own repo, zero-native-lottie, made
// at each release by tools/make-plugin-packages.ts) depends on it by url and version.
//
// lottie-spm from the version the CMake build pins (tools/fetch-lottie-apple.ts), up to the next major. It brings Lottie
// as a dynamic Lottie.framework that Xcode embeds; the CMake builds link Lottie-Static.
import PackageDescription

let package = Package(
  name: "ZeroNativeLottie",
  platforms: [.iOS(.v17)],
  products: [
    .library(name: "ZnPluginLottie", targets: ["ZnPluginLottie"]),
  ],
  dependencies: [
    .package(name: "ZeroNative", path: "../../.."),
    .package(url: "https://github.com/airbnb/lottie-spm.git", from: "4.6.1"),
  ],
  targets: [
    .target(
      name: "ZnPluginLottie",
      dependencies: [.product(name: "ZnRuntime", package: "ZeroNative"), .product(name: "Lottie", package: "lottie-spm")],
      path: "Sources/ZnPluginLottie", swiftSettings: [.swiftLanguageMode(.v5)]),
  ]
)
