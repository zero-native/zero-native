// swift-tools-version: 6.0
// zero-native's Firebase plugins for iOS, as a Swift package of their own (docs/publishing-plan.md §2.3), so an app
// without Firebase never downloads it. The main package (../../../Package.swift) has the runtime and the plugins that
// need no outside SDK; ios/packages/lottie has Lottie.
//
// The code stays in plugins/<name>/ios, where the CMake builds compile it: Sources/<target> are symlinks to those
// folders. Here the package depends on the main one by path; the copy apps get (its own repo, zero-native-firebase,
// made at each release by tools/make-plugin-packages.ts) depends on it by url and version, with the same targets.
//
// firebase-ios-sdk from the version the CMake build pins (tools/fetch-firebase-apple.ts), up to the next major: an app
// that adds a newer Firebase itself still resolves. The sample's Package.resolved keeps CI on the pinned one.
// Analytics is FirebaseAnalyticsCore: without the IDFA part (it would need the tracking prompt) and Google's on-device
// ad conversion, as the CMake build leaves them out.
import PackageDescription

let swift5: [SwiftSetting] = [.swiftLanguageMode(.v5)]
let runtime: Target.Dependency = .product(name: "ZnRuntime", package: "ZeroNative")

let package = Package(
  name: "ZeroNativeFirebase",
  platforms: [.iOS(.v17)],
  products: [
    .library(name: "ZnPluginFirebaseApp", targets: ["ZnPluginFirebaseApp"]),
    .library(name: "ZnPluginFirebaseAnalytics", targets: ["ZnPluginFirebaseAnalytics"]),
    .library(name: "ZnPluginFirebaseCrashlytics", targets: ["ZnPluginFirebaseCrashlytics"]),
    .library(name: "ZnPluginFirebaseMessaging", targets: ["ZnPluginFirebaseMessaging"]),
    .library(name: "ZnPluginFirebaseRemoteConfig", targets: ["ZnPluginFirebaseRemoteConfig"]),
    .library(name: "ZnPluginFirebasePerf", targets: ["ZnPluginFirebasePerf"]),
  ],
  dependencies: [
    .package(name: "ZeroNative", path: "../../.."),
    .package(url: "https://github.com/firebase/firebase-ios-sdk.git", from: "13.1.1"),
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
      name: "ZnPluginFirebaseRemoteConfig",
      dependencies: [runtime, "ZnPluginFirebaseApp", .product(name: "FirebaseRemoteConfig", package: "firebase-ios-sdk")],
      path: "Sources/ZnPluginFirebaseRemoteConfig", swiftSettings: swift5),
    // FirebasePerformance brings Remote Config, A/B Testing and GoogleDataTransport itself (iOS and tvOS only).
    .target(
      name: "ZnPluginFirebasePerf",
      dependencies: [runtime, "ZnPluginFirebaseApp", .product(name: "FirebasePerformance", package: "firebase-ios-sdk")],
      path: "Sources/ZnPluginFirebasePerf", swiftSettings: swift5),
  ]
)
