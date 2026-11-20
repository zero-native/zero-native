# Releasing

How zero-native's published pieces are made. The plan behind them, and what isn't built yet, is
[publishing-plan.md](publishing-plan.md). The npm, Maven and SwiftPM release itself (one tag, `release.yml`) doesn't
exist yet (§7 there).

## Hermes for the Swift package

The Swift package (`Package.swift`) gets Hermes as a binary target: a zip of `hermesvm.xcframework` on a GitHub Release
of this repo, named `hermes-<version>`. `Package.swift` names its url and SHA-256. A checkout that has fetched Hermes
(`bun run tools/fetch-hermes-apple.ts release`) uses that local copy instead, so working on the framework needs no
release.

**What is in the zip:** Meta's release Hermes from Maven Central (`com.facebook.hermes:hermes-ios`, the version and
SHA-256 pinned in `tools/fetch-hermes-apple.ts`), only its iOS device and simulator slices (5.2 MB zipped, against
19.3 MB for all of Meta's), zero-native's privacy manifest in each slice, and Hermes's MIT `LICENSE`.
`tools/make-hermes-zip.ts` makes it.

**When:** once now, and again each time Hermes is upgraded. An upgrade changes all of these together, because the
bytecode compiler, the JSI headers, `libjsi.so` and the engine must come from one release:
- `VERSION` and the two hashes in `tools/fetch-hermes-apple.ts`;
- `hermes-android` in `android/runtime/build.gradle.kts`;
- `hermes-compiler` in `package.json` and `tools/package.json`, then `bun install` and commit `bun.lock` (CI installs
  with `--frozen-lockfile`);
- the JSI headers (`core/third_party/jsi`) and the four `libjsi.so` in `android/runtime/src/main/jniLibs/`, from the
  React Native release that matches the new Hermes ([how](../core/third_party/jsi/README.md));
- the Hermes headers (`core/third_party/hermes`, [how](../core/third_party/hermes/README.md));
- the url and checksum in `Package.swift` (step 3 below).

### Steps

1. Push the Hermes version you want released to `main`. Then in GitHub: **Actions → Hermes release → Run workflow**
   (on `main`; the workflow refuses other branches). Or:

   ```bash
   gh workflow run hermes-release.yml --repo zero-native/zero-native --ref main
   ```

2. The workflow (`.github/workflows/hermes-release.yml`, on a GitHub Mac runner):
   - makes the zip and its checksum (`swift package compute-checksum`);
   - stops if the tag `hermes-<version>` exists;
   - builds the package sample against the new zip, for the simulator and for an iPhone (unsigned);
   - uploads the zip to a **draft** release `hermes-<version>` and writes the `url:` and `checksum:` lines in the run's
     summary;
   - downloads the zip back and checks its checksum, then publishes the release (not marked "latest": that stays for
     zero-native's own releases). If the checksum differs, it deletes the draft and fails, so it can run again.
3. Put those two lines in `Package.swift` (the `hermesvm` binary target) and commit, for example
   `ios: Package.swift uses Hermes 260318099.0.5 from its release`.
4. Check that the package now builds from the release: move `ios/third_party/hermes/release` away for a moment and
   build `ios/SamplePackage` with an empty package cache:

   ```bash
   xcodebuild -project ios/SamplePackage/ZnSamplePackage.xcodeproj -scheme ZnSamplePackage -destination 'generic/platform=iOS Simulator' -clonedSourcePackagesDirPath "$(mktemp -d)" build
   ```

   Its log should have `Downloading binary artifact https://github.com/zero-native/zero-native/releases/download/hermes-<version>/hermesvm.xcframework.zip`.
   An app outside the repo resolves the same url.

**Before releasing, try a zip locally:** `bun run tools/make-hermes-zip.ts` writes `build/hermes-zip/`. To build
against it, set `ZN_HERMES_ZIP=build/hermes-zip/hermesvm.xcframework.zip` for `xcodebuild`.

**SwiftPM caches `Package.swift`'s answer.** Which Hermes it picks (a zip, the local copy, the release) is decided when
the manifest is read, and SwiftPM keeps that. After fetching, moving or deleting Hermes: in Xcode, File → Packages →
Reset Package Caches; on the command line, `-clonedSourcePackagesDirPath` with a new folder as above, or
`swift package purge-cache`.

### Never

- **Never replace or delete a published `hermes-*` release, or upload another zip to it.** Apps that resolved the
  package keep its checksum, and SwiftPM refuses a zip whose checksum changed. A new zip is a new Hermes version, so a
  new release. (A draft the workflow left behind, after a failed download, can be deleted: it has no tag.)
- Don't make the zip on your own machine and upload it by hand: the workflow makes it from the pinned download, and the
  release notes say which commit made it.

**Open:** Meta's framework isn't code-signed, and neither is this zip. Whether Apple wants a signature on a re-hosted
SDK from its privacy list is not checked yet (publishing-plan §9).

## The second Swift package (Firebase and Lottie)

`ios/ExtrasPackage` holds the plugins that need Google's or Airbnb's SDKs. Here its targets are symlinks to
`plugins/<name>/ios` and it depends on the main package by path. Apps can't use it from this repo: SwiftPM wants a
package at the root of its own repo. So each zero-native release also makes a copy for its own repo:

```bash
bun run tools/make-extras-package.ts --version 0.1.0
```

It writes `build/extras-package/`: the Swift files themselves (not symlinks), `Package.swift` depending on
`https://github.com/zero-native/zero-native.git` at exactly that version, the README, `LICENSE` and `NOTICE`. That
folder is committed to the second repo and tagged with the same version, after the main repo's tag exists. The repo's
name, and the job that does this in `release.yml`, are not decided or written yet (publishing-plan §7).

The package asks for Firebase and Lottie **from** a version, up to the next major, not exactly: an app that adds
Firebase or Lottie itself at a newer version must still resolve. The lowest versions are the ones the CMake build pins.
When upgrading, raise them in `ios/ExtrasPackage/Package.swift` and in `tools/fetch-firebase-apple.ts` /
`tools/fetch-lottie-apple.ts` together (a test checks they match), then let Xcode update the sample's
`Package.resolved` (CI builds only with the versions in it).

The copy's README is `ios/ExtrasPackage/README.release.md`; the release puts it in as `README.md`.
