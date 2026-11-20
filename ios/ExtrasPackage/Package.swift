// swift-tools-version: 6.0
// zero-native's iOS plugins that need Google's or Airbnb's SDKs, as a second Swift package (docs/publishing-plan.md
// §2.3), so an app without them never downloads Firebase or Lottie. The main package (../../Package.swift) has the
// runtime and the other plugins.
//
// The code stays in plugins/<name>/ios, where the CMake builds compile it: Sources/<target> are symlinks to those
// folders. Here the package depends on the main one by path; the copy apps get (its own repo, made at release time)
// depends on it by url and version, with the same targets.
//
// The SDKs' lowest versions are the ones the CMake build pins (tools/fetch-firebase-apple.ts, tools/fetch-lottie-apple.ts),
// up to the next major: an app that adds Firebase or Lottie itself, at a newer version, still resolves. The sample's
// Package.resolved keeps CI on the pinned ones.
// Lottie comes from lottie-spm as a dynamic Lottie.framework that Xcode embeds; the CMake builds link Lottie-Static.
// Analytics is FirebaseAnalyticsCore: without the IDFA part (it would need the tracking prompt) and Google's on-device
// ad conversion, as the CMake build leaves them out.
import PackageDescription

let swift5: [SwiftSetting] = [.swiftLanguageMode(.v5)]
let runtime: Target.Dependency = .product(name: "ZnRuntime", package: "ZeroNative")

let package = Package(
  name: "ZeroNativeExtras",
  platforms: [.iOS(.v17)],
  products: [
    .library(name: "ZnPluginFirebaseApp", targets: ["ZnPluginFirebaseApp"]),
    .library(name: "ZnPluginFirebaseAnalytics", targets: ["ZnPluginFirebaseAnalytics"]),
    .library(name: "ZnPluginFirebaseCrashlytics", targets: ["ZnPluginFirebaseCrashlytics"]),
    .library(name: "ZnPluginFirebaseMessaging", targets: ["ZnPluginFirebaseMessaging"]),
    .library(name: "ZnPluginLottie", targets: ["ZnPluginLottie"]),
  ],
  dependencies: [
    .package(name: "ZeroNative", path: "../.."),
    .package(url: "https://github.com/firebase/firebase-ios-sdk.git", from: "13.1.1"),
    .package(url: "https://github.com/airbnb/lottie-spm.git", from: "4.6.1"),
  ],
  targets: [
    .target(
      name: "ZnPluginFirebaseApp",
      dependencies: [
        runtime,
        .product(name: "FirebaseCore", package: "firebase-ios-sdk"),
        .product(name: "FirebaseInstallations", package: "firebase-ios-sdk"),
      ],
      path: "Sources/ZnPluginFirebaseApp", swiftSettings: swift5),
    .target(
      name: "ZnPluginFirebaseAnalytics",
      dependencies: [runtime, "ZnPluginFirebaseApp", .product(name: "FirebaseAnalyticsCore", package: "firebase-ios-sdk")],
      path: "Sources/ZnPluginFirebaseAnalytics", swiftSettings: swift5),
    .target(
      name: "ZnPluginFirebaseCrashlytics",
      dependencies: [runtime, "ZnPluginFirebaseApp", .product(name: "FirebaseCrashlytics", package: "firebase-ios-sdk")],
      path: "Sources/ZnPluginFirebaseCrashlytics", swiftSettings: swift5),
    .target(
      name: "ZnPluginFirebaseMessaging",
      dependencies: [
        runtime, "ZnPluginFirebaseApp",
        .product(name: "ZnPluginNotifications", package: "ZeroNative"),
        .product(name: "FirebaseMessaging", package: "firebase-ios-sdk"),
      ],
      path: "Sources/ZnPluginFirebaseMessaging", swiftSettings: swift5),
    .target(
      name: "ZnPluginLottie",
      dependencies: [runtime, .product(name: "Lottie", package: "lottie-spm")],
      path: "Sources/ZnPluginLottie", swiftSettings: swift5),
  ]
)
