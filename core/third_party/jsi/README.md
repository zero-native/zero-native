# JSI headers

Copied from `com.facebook.react:react-android:0.88.1` (prefab module `jsi`), the release that matches
`com.facebook.hermes:hermes-android:260318099.0.5` (RN's `sdks/hermes-engine/version.properties` names the Hermes
version of each RN release). The matching `libjsi.so` (the stripped one from the AAR's `jni/arm64-v8a/`) lives in
`android/runtime/src/main/jniLibs/arm64-v8a/`. The x86_64 one (for emulators, debug builds only) is from the same AAR's
`jni/x86_64/`, added 2026-11-03 from Maven Central's `react-android-0.88.1-release.aar` (SHA-1 matched Maven's; its arm64
`libjsi.so` is byte-identical to ours). Upgraded 2026-10-30 from RN 0.87.1 / Hermes 250829098.0.17: only
`decorator.h` changed; `jsi.h` was identical.

Hermes' own headers include `<jsi/jsi.h>`, but the Hermes AAR doesn't ship them (verified 2026-10-27).
**Headers, `libjsi.so`, `libhermesvm.so` and `hermesc` must all come from the same release.** When upgrading Hermes,
replace all four together.
