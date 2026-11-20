# Publishing plan: npm, Maven Central and SwiftPM

Written 2026-11-19. **Nothing has been published, no account was made and no name was
reserved.** Today an app builds zero-native from a checkout: a Gradle composite build, `bun link`, and CMake pointing at
the repo (`guide-notes.md` §34, `second-opinions.md` entry 17). This file says what to publish, under which names,
how to sign it, and in what order.

How to read the marks (`[check]` as in `README.md` of this folder; `[fact]` is this file's own):
- **[fact]** checked on 2026-11-19, with how it was checked.
- **[check]** believed, not confirmed.
- **Recommended** is a proposal; what is still open is in §9.

---

## 1. The short version
- **Names are the first problem, not the build.** A different project called "zero-native" came first. Vercel Labs
  started a desktop toolkit under that name on 2026-05-08 and later renamed it "Native SDK". It still holds the npm
  name `zero-native`, and both `zero-native.dev` and `zeronative.dev` point at its site (§3). So **`dev.zeronative`
  can't be proven for Maven Central** by us, and the unscoped npm name is gone.
- **What we can use:** the GitHub org `zero-native` (ours). The npm scope `@zero-native` is taken by someone else, so
  **the npm org `zeronative` was made on 2026-11-19**, and the code was renamed to `@zeronative/*` the same day
  (§10 step 2): `@zeronative/core`, `@zeronative/ui` and so on.
- **Publish three things with one version number**, from one git tag:
  - 25 npm packages: core, template, ui, compiler, 20 plugins and a new `@zeronative/cli`;
  - 20 Android libraries (AARs) on Maven Central: the runtime and 19 plugins;
  - one Swift package (SwiftPM). Hermes comes in it as a prebuilt XCFramework that we host.
- **No CocoaPods.** CocoaPods trunk stops taking new pods on 2026-12-02 (§5.4).
- **Effort:** about 3 to 4 weeks of focused work. The iOS package is the biggest part, because the iOS runtime has no
  `public` API today (§5.2).

## 2. What gets published

### 2.1 npm (JS, the compiler and the CLI)
[fact] read from every `package.json` on 2026-11-19. All are `"private": true`. The packages under `packages/` and `plugins/` are version `0.0.0`; the root, `server/`
and `examples/sample/` have no version at all. None has
`files`, `license`, `repository` or `publishConfig`. Each one's `main` is its TypeScript source (`src/index.ts`).
Only `@zeronative/image-viewer` has `exports` (`.` and `./screen`).

| Package | Folder | Publish? | Notes |
|---|---|---|---|
| `@zeronative/core` | `packages/core` | yes | The compiler imports `@zeronative/core/src/host-api`, so `exports` must allow that path (or the compiler imports it another way). |
| `@zeronative/template` | `packages/template` | yes | The registry. Needed by the compiler. |
| `@zeronative/ui` | `packages/ui` | yes | |
| `@zeronative/compiler` | `compiler` | yes | Uses Bun APIs (`BunPlugin`, `Bun.*`), so it runs on Bun only. |
| `@zeronative/<plugin>` | `plugins/*` | 20 of 21 | Not `device-test` (it tests the sample). `markdown` is JS only. Each keeps its `zeroNative` field: the compiler reads it (`compiler/src/modules.ts`). |
| `@zeronative/cli` (new) | from `tools/` | yes | `bin: { "zn": ... }`. Today `zn` is the root package's bin (`tools/zn.ts`), set up with `bun link`. |
| `@zeronative/updates-server` | `server` | no | A server, not a library. A container image later, if people ask (§8). |
| `@zeronative/example-sample` | `examples/sample` | no | |

**Done 2026-11-19 (§10 step 2):** every package above marked "yes" has `license`, `repository`, `files`,
`publishConfig` and a README, and isn't `private`. The CLI is `tools/package.json` (the files stay where they are; its
`files` list says which are published). `bun run tools/pack.ts` packs all 25 the way `npm publish` would send them and
checks each one; CI runs it. Installed from those tarballs into an app outside the repo, `zn builtin` built the app,
and the bundle was byte for byte the one the same app built from a checkout. Two things that test found, both fixed:
plugins now write `zeroNative.platforms` (the npm package has no `ios/` folder to look at), and a package in the app's
`node_modules` is named by its package in the bundle's comments, as a linked one is. `zn new`, `zn ota` and `zn server`
still need a checkout. Versions stay `0.0.0` until the release script (step 5).

What the CLI package must hold [fact, from `tools/zn.ts` and `tools/zn-build.ts`]:
- `tools/zn.ts`, `zn-build.ts`, `zn-dev.ts`, `hermesc.ts`, `bundle-info.ts`, `tools/updates/` and `tools/ota/`. Today
  they find each other and the compiler by paths inside the repo (`import.meta.dir`, `../compiler/src`). In a package
  they must import `@zeronative/compiler` instead.
- `hermes-compiler` as a dependency, pinned **exactly** to `260318099.0.5`. [fact] npm has that version, and its
  `latest-v1` tag is already `260318099.0.8`. A range would let a newer `hermesc` in, and bytecode must match the
  Hermes in the app (`core/third_party/jsi/README.md`).
- `engines: { "bun": ">=1.3" }`. Every tool uses Bun APIs.

Shipping `.ts` source (no build step) is fine for Bun, and app type checks already read the `.ts` files. Each package
needs `files` (`src`, `README.md`, `LICENSE`, `NOTICE`), `license: "Apache-2.0"`, `repository` (with `directory`) and
`publishConfig: { "access": "public" }`. A scoped package is private by default on npm.

### 2.2 Maven Central (Android)
[fact] read from `android/settings.gradle.kts` and each `build.gradle.kts`.

- **Group:** see §3.2. The code uses `dev.zeronative` for Kotlin packages and Android namespaces.
- **Artifact ids** are already chosen: Gradle uses the project name. The first outside app already asks for
  `dev.zeronative:runtime` and `dev.zeronative:plugin-<name>` and maps them to projects (`guide-notes.md` §34).
- **What to publish:** `runtime`, plus `plugin-<name>` for the 19 plugins with an `android/` folder, except
  `device-test`.
- **What a runtime AAR holds:**
  - the Kotlin runtime;
  - `libzn.so`: the JNI bridge, the C++ core and MMKV, built by CMake;
  - `libjsi.so`: copied from React Native's `react-android` 0.88.1 AAR (`android/runtime/src/main/jniLibs`);
  - `libc++_shared.so`;
  - the checked-in Baseline Profile (`src/main/generated/baselineProfiles`) and `consumer-rules.pro`.
- **CPU types:** the release variant builds `arm64-v8a`, `armeabi-v7a`, `x86` and `x86_64`. Publish only the release
  variant, never one built with `-PznArm64Only`.
- **Hermes:** `api("com.facebook.hermes:hermes-android:260318099.0.5")`, already on Maven Central from Meta. The
  runtime's POM simply depends on it. We don't re-host it. `libhermesvm.so` and `libfbjni.so` stay out of our AAR, as
  today (`packaging.jniLibs.excludes`).
- **Plugin dependencies:** `implementation(project(":runtime"))` and `project(":plugin-firebase-app")` become normal
  POM dependencies once every project has a group and a version. Nothing to change in the plugins.
- **Firebase setup script:** `plugins/firebase-app/firebase.gradle.kts` is applied by file path. An app can't do that
  from Maven. For 0.x, `zn new` copies it into the app. A small Gradle plugin can come later.
- **What apps need:** AGP 9.2, Kotlin 2.4 (Compose compiler plugin), compileSdk 37, Java 21, minSdk 24. The README
  must say so, because published Kotlin metadata needs a new enough Kotlin to read.
- **Check before 0.1.0 [check]:** a `libc++_shared.so` clash with Hermes's own copy in an app; React Native's `libjsi.so`
  clashing in an app that also has React Native (unlikely, but say so).

Maven Central's rules [fact, central.sonatype.org/publish/requirements, read 2026-11-19]:
- a sources jar and a javadoc jar next to each artifact (an empty javadoc jar is accepted);
- `.md5` and `.sha1` for every file;
- a GPG `.asc` signature for every file;
- a POM with `name`, `description`, `url`, a license, a developer and `scm`;
- no `-SNAPSHOT` versions.

Recommended tool: the `com.vanniktech.maven.publish` Gradle plugin. It writes the POM, the extra jars and the
signatures, and uploads to the Central Portal. [check] that its current version works with AGP 9.2.

### 2.3 SwiftPM (iOS)
[fact] read from `ios/CMakeLists.txt` and the code. Today CMake makes one Xcode project. It compiles the C++ core
(and MMKV), the Objective-C++ host (`ZNHost.mm`), the Swift runtime (44 files) and every plugin's Swift **into the
app's own module**. So plugins don't `import` anything, and **the runtime has no `public` declaration at all**
(0 found).

Recommended: **one Swift package**, `ZeroNative`:

| Target | Kind | From |
|---|---|---|
| `ZnCore` | C++ | `core/src`, `core/include`, MMKV (`core/third_party/mmkv`) with `FORCE_POSIX` as in `core/CMakeLists.txt` |
| `ZnHost` | Objective-C++ | `ios/ZnRuntime/Host` |
| `ZnRuntime` | Swift | `ios/ZnRuntime/Swift`, plus `ZnRuntime_Privacy.bundle` as a resource |
| `hermesvm` | binary target | a zip of `hermesvm.xcframework`, hosted by us (below) |
| `ZnPlugin<Name>` | Swift, one per plugin | `plugins/<name>/ios` |
| `ZnNotificationService` | Swift | `plugins/firebase-messaging/ios-service`, for the app's notification extension |

The work this needs [fact: what is missing today]:
- `public` on everything an app and a plugin use: `ZnApp`, `ZnPlugins.register`, the plugin and module types. Each
  plugin then adds `import ZnRuntime`. This changes no behaviour, but it touches most runtime files.
- The Hermes headers (`include/hermes`, `include/jsi`, 536 KB, 47 files) must be in the package. Meta's framework has
  none inside, and `ZnCore` needs `<hermes/hermes.h>`.
- Firebase and Lottie: today the app links Google's and Airbnb's XCFrameworks, and the plugins check
  `canImport(FirebaseCore)`. In SwiftPM a target only sees its declared dependencies. So the Firebase plugins must
  depend on `firebase-ios-sdk`, and Lottie on `lottie-spm`. Then every app resolves (downloads) Firebase, even one that
  uses none of it. **Chosen 2026-11-20: a second package** (§9).

**The second package** (`ios/ExtrasPackage`, 2026-11-20): the Firebase app, Analytics, Crashlytics and Messaging
plugins and Lottie, as `ZnPlugin<Name>` targets. Their code stays in `plugins/<name>/ios`, where the CMake builds compile
it: `ios/ExtrasPackage/Sources/<target>` are relative symlinks to those folders (SwiftPM follows them; tried). It
depends on the main package by path, on `firebase-ios-sdk` from 13.1.1 and `lottie-spm` from 4.6.1 (the CMake build's
pins as the lowest versions, so an app can add a newer Firebase or Lottie itself). Analytics uses `FirebaseAnalyticsCore`: Firebase's plain `FirebaseAnalytics` product brings the IDFA module and
Google's on-device ad conversion, which the CMake build leaves out. The main package no longer has these five targets:
two packages can't have targets of the same name.
- **At release** (§7), a job copies `ios/ExtrasPackage` with the symlinks resolved into its own repo, changes the
  dependency on the main package from the path to its url and the release version, and tags that repo with the same
  version. The repo's name is still to choose (it holds Lottie too, so not only "firebase").
- **Lottie** comes from `lottie-spm` as a dynamic `Lottie.framework` that Xcode embeds; the CMake builds link
  `Lottie-Static`. The app gets the same Lottie, packed differently.
- **Not checked yet:** the Crashlytics dSYM upload for an app on the package (Firebase's own run script, documented by
  Google), and the notification service extension (`plugins/firebase-messaging/ios-service`).

**Done 2026-11-19 (§10 step 4, without the Hermes zip):** `Package.swift` at the repo root has the targets above
(`ZnMMKV`, `ZnCore`, `ZnHost`, `ZnRuntime` with the privacy manifest, `hermesvm`, one `ZnPlugin<Name>` per plugin; the
notification service extension is not in it yet). The runtime and plugins have a `public` API (the plugin contract,
`ZnApp.start`, OTA setup, the helpers plugins use), and each file imports what it needs under `#if SWIFT_PACKAGE` (an
app's files: `#if canImport(ZnRuntime)`), so the CMake builds, ZeroBill's included, don't change. The 8 Hermes headers
the core needs are in `core/third_party/hermes`. `ios/SamplePackage` builds the sample from the package; on the
simulator its screens matched the CMake build's, and CI builds it. Firebase and Lottie are in the second package
(above).
Still to do: the Hermes zip on a GitHub Release (the workflow exists; until it runs, `Package.swift` uses a local Hermes,
so an app outside the repo can't use the package yet), and the notification service target.

**Hermes as a binary target** [fact, run on this Mac, 2026-11-19]:
- Meta publishes `hermes-ios` on Maven Central as a `.tar.gz`. SwiftPM needs a `.zip` at an HTTPS URL, with its SHA-256
  in `Package.swift`.
- Meta's `hermesvm.xcframework` has no privacy manifest. `tools/fetch-hermes-apple.ts` adds one, so our zip must be a
  rebuilt copy. Hermes is MIT: the zip carries its `LICENSE`.
- Meta's XCFramework has 7 slices (iOS, Mac Catalyst, tvOS, visionOS), and the release one is 67 MB unzipped, 19.3 MB
  zipped. Rebuilt with only the iOS device and simulator slices (`xcodebuild -create-xcframework`), it zips to
  **5.2 MB**.
- `swift package compute-checksum` on that zip gave
  `9bb1a77d7f8c01d50e6dd9810e4e0f3e571076cfe76d463b98881efd2d39d81b`. It is a local test only: a zip made on another
  machine or day can differ, so the release workflow makes the zip once and the checksum goes in with it.
- `codesign -dv` says Meta's framework "is not signed at all". [check] whether Apple's rule for SDKs on its privacy
  list also wants a signature from us on a re-hosted Hermes. If yes, signing needs an Apple Developer team (§9).
- One binary target means one Hermes flavor. Ship release Hermes. Framework developers keep the debug one through the
  CMake build, as today.

**Done 2026-11-20:** `tools/make-hermes-zip.ts` and `.github/workflows/hermes-release.yml` (run by hand), documented in
[releasing.md](releasing.md). The zip built the package sample for the simulator and an iPhone. It isn't released yet.

**Hermes ships on its own release.** The checksum must be in `Package.swift` in the tagged commit. So the Hermes zip
can't be built by the same tag that points at it. Make it a separate GitHub Release, `hermes-260318099.0.5`, built
once by its own workflow. `Package.swift` points at that URL. A new zip is needed only when Hermes is upgraded.

**Where `Package.swift` lives.** SwiftPM wants it at the root of a git repo, and it fetches that whole repo. At the
root of this repo, every app's first build clones Android, the experiments and the docs too. That is the simplest start.
If the clone is slow, mirror the iOS parts into `zero-native/zero-native-swift` on each release. [check] how big a
fresh clone of this repo is. SwiftPM has no central registry: a package is a git URL and its tags. The Swift Package
Index only lists packages.

**Tags:** SwiftPM reads semver tags. Use `0.1.0` or `v0.1.0`. [check] that SwiftPM in Xcode 26 accepts the `v`
form. If in doubt, tag without `v`.

### 2.4 What is not published
- `device-test`, the sample, `server/` (see §8), `test-kit`, `experiments`.
- The app's own plugins (such as a UPI plugin): they stay in the app's repo (`plugins.md` D7).

## 3. Names and namespaces

### 3.1 npm [fact: registry lookups, 2026-11-19]
| Name | State |
|---|---|
| `zero-native` (unscoped) | **Taken.** "Zig desktop app shell with WebView — CLI tools", 0.0.0 to 0.3.0 (2026-05-08 to 2026-06-24). Repository `vercel-labs/zero-native`, which GitHub now redirects to `vercel-labs/native` ("Native SDK"). It has a `zero-native` bin. |
| `zn` | Taken (an empty 0.0.0 by someone else). |
| `create-zn`, `zn-cli` | Taken. |
| `create-zero-native`, `zero-native-cli` | Free (404). |
| `@zero-native` scope | **Exists, no public packages.** `registry.npmjs.org/-/org/zero-native/package` answers `{}` (a scope that doesn't exist answers 404 "Scope not found"). The public API doesn't say whose it is. |
| `@zero-native/core`, `/ui`, `/compiler`, `/cli`, `/create` | Free (404), but they can only be published by the scope's owner. |
| `@zeronative`, `@zn-dev` scopes | Not found (free). |

So the packages use the scope `@zeronative` (§1), whose npm org is ours. Our CLI's bin
is `zn`; the docs must never tell people to run `npx zero-native`, which runs the other project's CLI.

### 3.2 Maven Central [fact: DNS, RDAP, the Central docs]
- Central proves a namespace by a DNS TXT record on the domain, read backwards: `dev.zeronative` needs
  `zeronative.dev` (central.sonatype.org/register/namespace).
- `zeronative.dev`: registered 2026-05-08 at Name.com, Vercel's DNS, and it redirects (308) to `native-sdk.dev`.
  `zero-native.dev` is the same: registered 2026-05-08 at Name.com, redirects to `native-sdk.dev`. The
  `vercel-labs/native` repo was made the same day. So **we can't get `dev.zeronative` unless the domain's owner gives
  it**.
- Maven Central has nothing under `dev/zeronative` (404), so no one has published there either.
- Other ways to get a namespace:
  - `io.github.<GitHub login>`: given at once when you sign up to the Central Portal with that GitHub account. It is a
    person's, not the org's.
  - `io.github.zero-native`: the Central docs say only the login you signed up with is automatic, not an org name.
    [fact, 2026-11-20] Added by hand in the Portal, it was verified the way the docs describe for a personal account:
    a temporary, empty public repository in the `zero-native` org, named after the Portal's verification key. It is
    **verified** and is the group (§9).
  - A domain we own. DNS showed no name servers for `zero-native.org`, `zeronative.io`, `zero-native.io`,
    `zeronative.app` and `znative.dev`, so they may be free. **Not checked with a registrar.** `zeronative.com` and
    `zeronative.org` have name servers (taken).
- The Maven group doesn't have to equal the Kotlin package. We can publish `io.zeronative:runtime` and keep the code in
  `dev.zeronative.*`. Renaming the Kotlin packages would change every plugin's class name in `package.json`
  (`zeroNative.android.plugin`) and every app's imports, so it is a pre-1.0 job of its own, if at all.

### 3.3 GitHub and SwiftPM [fact]
- The org `zero-native` exists (made 2026-11-18) with one public repo, `zero-native/zero-native`. It is ours.
- SwiftPM names come from the git URL, so there is no name to reserve. The package can be called `ZeroNative`.

## 4. Accounts
| Account | What for |
|---|---|
| npm org `zeronative` | publishing `@zeronative/*`; at least two human owners, so one lost phone (2FA) can't lock the project |
| Sonatype Central Portal | the Maven namespace and its publishing token |
| GPG key | signing Maven files: a key for the project, its public half on `keys.openpgp.org` and `keyserver.ubuntu.com` |
| GitHub org `zero-native` | the repo, Releases (the Hermes zip), Actions |
| Apple Developer team | only if the Hermes XCFramework must be signed (§2.3) |
| Domain for the Maven group | DNS proof (§3.2) |

Secrets go in a GitHub **environment** named `release`, with a maintainer as its required reviewer. CI on pull
requests never sees them.

## 5. Signing and integrity

### 5.1 npm: trusted publishing [fact: docs.npmjs.com/trusted-publishers, read 2026-11-19]
- The release job gets a short-lived token from GitHub's OIDC (`permissions: id-token: write`). No npm token is
  stored.
- Provenance is made automatically for a public package published from a public repo on GitHub-hosted runners.
- It needs npm CLI 11.5.1+ and Node 22.14+. So the job publishes with `npm publish`, not `bun publish`. [check]
  whether `bun publish` supports OIDC and provenance yet.
- The trusted publisher is set in each package's settings on npmjs.com. So the package must exist first: the very
  first publish of each name needs a token, made by an owner by hand (granular tokens last at most 90 days). The docs
  don't say this outright; it follows from where the setting lives. [check]
- Classic npm tokens were turned off in late 2025, so a long-lived token is not an option anyway.

### 5.2 Maven: GPG
- Every file gets an `.asc` signature. The key and its passphrase are secrets of the `release` environment.
- The Central Portal user token (a name and password pair) is the upload secret.
- Upload as a "deployment", check it in the portal, then publish. Turn on automatic publishing only after a few clean
  releases. A release on Central can never be deleted.

### 5.3 SwiftPM: checksums
- No signatures. What protects an app is the SHA-256 in `Package.swift` (Xcode refuses a zip that doesn't match) and
  the git tag.
- Extra, cheap: `actions/attest-build-provenance` on the Hermes zip, so anyone can check it came from our workflow.

### 5.4 Why not CocoaPods
[fact: CocoaPods blog, as quoted by several sources] Trunk becomes read-only on 2026-12-02: no new pods or versions
after that. Firebase stopped publishing to CocoaPods in October 2026. SwiftPM only.

## 6. Versioning
- **One version for everything**: every npm package, every AAR and the Swift package. Start at `0.1.0`. One tag,
  `v0.1.0`, makes all of them. The plugins and the runtime are tested together, and a "core 0.4 with scanner 0.2"
  matrix would never be tested.
- **0.x semver:** a minor bump (`0.2.0`) may break the API. A patch (`0.1.1`) is fixes only. Every release lists what
  changed for app authors.
- **The contract numbers are not package versions.** The registry version (24 today), the host API version (9) and the
  Hermes bytecode format (99) say what a native build can run. Bundles carry them, and a phone checks them before it
  takes an OTA bundle (`ota.md` §3.2). They change on their own rules (`adding-components.md`).
  - Each release's notes list the four numbers it has: registry, host API, bytecode, Hermes version.
  - A release that raises the registry or the host API is at least a minor bump. That tells app authors: "rebuild the
    store app, older installs won't take bundles that use the new things".
  - A plugin's native module version (for example `nativeModule("Location", { version: 2 })`) is per module, not the
    package's version. It stays as it is.
- **Hermes is pinned in three places**, all exact: `hermes-compiler` (npm, in the CLI), `hermes-android` (the runtime's
  POM) and the Hermes zip (`Package.swift`). The release check fails if they differ.
- **Before each release, a script checks:** every `package.json` and `gradle.properties` has the tag's version; the
  internal `workspace:*` dependencies became that exact version (Bun's publish does this; `npm publish` does not, so
  the script rewrites them); `bun run gen:registry` changes nothing; the host API test passes.

## 7. The release workflow
A new `.github/workflows/release.yml`, run on a pushed tag `v*`. The existing CI (`ci.yml`) stays as it is.

1. **check** (Linux): `bun install --frozen-lockfile`, `bun run sample:js`, `bun run test`, the version script (§6).
2. **npm** (Linux, environment `release`): `npm publish --access public` for each package, in dependency order: core,
   template, ui, compiler, plugins, cli. Provenance comes with trusted publishing.
3. **maven** (Linux, environment `release`): JDK 21, the Android SDK as in `ci.yml`, then
   `./gradlew publishToMavenCentral` for the runtime and the 19 plugins, release variant, all four CPU types. The
   deployment waits in the portal until it is published (by hand at first).
4. **ios** (macOS, Xcode 26): build the Swift package for the simulator and a device (`xcodebuild` on the package's
   products), and build the sample from the package. Nothing is uploaded: the tag itself is the SwiftPM release.
5. **github-release**: notes with the four contract numbers, links to the npm packages and Maven artifacts.

Separate, by hand: `hermes-release.yml` (`workflow_dispatch`, macOS). It fetches Meta's Hermes, adds the privacy
manifest, keeps only the iOS slices, zips it, prints the checksum and uploads the zip to a GitHub Release named
`hermes-<version>`. Run once per Hermes upgrade. Then commit the URL and checksum into `Package.swift`.

**Dry run before 0.1.0:** `npm publish --dry-run` (and `npm pack` installed into an app outside the repo);
`./gradlew publishToMavenLocal` used by an app through `mavenLocal()`; a Central deployment that is dropped instead of
published; a test tag on a fork for SwiftPM.

## 8. What changes for app authors once published
- **README, Quick start:** a new app comes from `bunx @zeronative/cli new my-app` (or `bun create zero-native`, which
  needs the free name `create-zero-native`). The "Status" line says the packages are on npm, Maven Central and
  SwiftPM, at version 0.x. Building from this repo moves to a "Work on the framework" part.
- **`guide-notes.md` §34:** the composite build and `bun link` become the way to work on the framework, not the way to
  use it. An app's `package.json` gets `"@zeronative/core": "0.1.0"` and a dev dependency on `@zeronative/cli`, so
  `zn` comes from `node_modules/.bin`. No `bun link` per computer: this also fixes the weak part of
  `second-opinions.md` entry 17 (CI needs no setup).
- **Android app:** `implementation("<group>:runtime:0.1.0")` and `implementation("<group>:plugin-scanner:0.1.0")`,
  with `mavenCentral()` (already in every app's repositories). The first outside app deletes its `includeBuild` block,
  as its own comment says.
- **iOS app:** adds the package URL in Xcode, picks `ZnRuntime` and the plugin products, and copies the JS bundle in
  a build phase. Today apps make their Xcode project with CMake from the zn sources. `zn new` would write a normal
  Xcode project from a template instead. Making that template is part of the work (§10, step 6).
- **`zn new` does not exist yet** [fact: not in `tools/zn.ts`]. It would write: `app/src/main.ts` with one screen, the
  Android host (Gradle files with the pinned AGP, Kotlin and wrapper versions, `firebase.gradle.kts` copied), the iOS
  host, `zn-updates.json`, and a `package.json` with every `@zeronative/*` version equal to the CLI's own.
- **zn-updates server:** stays "run it from the repo" for 0.1. A container image on GHCR later if people ask.

## 9. Open choices
**Chosen 2026-11-20:** the Maven group is **`io.github.zero-native`**, verified on the Central Portal for the GitHub
org (§3.2). The artifact ids stay as §2.2 has them: `io.github.zero-native:runtime` and
`io.github.zero-native:plugin-<name>`. The Kotlin packages stay `dev.zeronative.*`.

**Chosen 2026-11-20:** Firebase and Lottie for iOS go in a **second Swift package**, so apps without them never
download Google's or Airbnb's SDKs (§2.3).

Before 0.1.0 the maintainers still choose:
- **Signing a re-hosted Hermes** (§2.3), if Apple's rule asks for it, and with which Apple team.

The rest of this plan assumes one version for everything from 0.1.0 (§6), SwiftPM only (§5.4), Bun only for 0.x, and
a release that a maintainer approves (§7).

## 10. The ordered plan
Days are focused working days, one engineer with AI, **target** (not measured).

| # | Step | Days | Done when |
|---|---|---|---|
| 1 | The open choices (§9); make or confirm the npm org, the Central account and namespace, the GPG key | 0.5 (plus DNS wait) | the namespace shows "verified" in the Central Portal |
| 2 ✓ | npm: package fields (`version`, `files`, `license`, `repository`, `exports`, `publishConfig`), the core deep import, `@zeronative/cli` out of `tools/` | 2–3 | `npm pack` of each, installed in a new app outside the repo, builds a bundle with `zn builtin` |
| 3 | Maven: one shared publishing setup for the runtime and 19 plugins, POM data, signing | 2–3 | an outside app builds from `mavenLocal()` with no `includeBuild` (needs a machine with the Android SDK; this Mac has none) |
| 4 (most) | SwiftPM: `public` API, plugin targets with `import ZnRuntime`, `ZnCore` with MMKV, Hermes headers, the Hermes zip release, `Package.swift`; the sample builds from it | 5–8 | the sample from the package runs on the simulator with the same screens as the CMake build |
| 5 | The version check script, `release.yml`, `hermes-release.yml`, the dry run (§7) | 2 | a fork's test tag goes green end to end |
| 6 | `zn new`, the iOS app template, README and `guide-notes.md` §34 rewritten | 2–4 | `zn new demo` gives an app that runs on both OSes |
| 7 | Release 0.1.0; move the first outside app to it | 1–2 | that app's Android and iOS builds use only published artifacts |

Total: **about 15 to 22 days.** Steps 2, 3 and 4 can run in parallel once step 1 is done. Step 4 is the riskiest.

## 11. What was checked, and how
- npm: `npm view` and `registry.npmjs.org` for each name; `/-/org/<scope>/package` for scopes (a made-up scope gives
  404 "Scope not found"; `@zero-native` gives 200 `{}`).
- Domains: `dig` for name servers; RDAP at `pubapi.registry.google` for `.dev` dates and registrar; `curl -I` for
  the redirects.
- GitHub: `gh api orgs/zero-native` and `repos/vercel-labs/zero-native` (redirects to `vercel-labs/native`, made
  2026-05-08).
- Maven Central: `repo1.maven.org/maven2/dev/zeronative/` (404); `hermes-ios` 260318099.0.5 (200; release tarball
  25.4 MB).
- Hermes zip: `bun run tools/fetch-hermes-apple.ts release`, `xcodebuild -create-xcframework` (iOS slices),
  `ditto -c -k`, `swift package compute-checksum`, `codesign -dv`, on this Mac with Xcode 26.
- Rules: central.sonatype.org (namespace, requirements), docs.npmjs.com (trusted publishers), CocoaPods' read-only
  date via several articles quoting its blog.
- **Not done:** any Android build (no Android SDK on this Mac); any publish, account or name reservation; a registrar
  check for the free-looking domains; who owns `@zero-native` on npm.
