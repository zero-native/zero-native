# JSI headers

Copied from `com.facebook.react:react-android:0.87.1` (prefab module `jsi`), the release that matches
`com.facebook.hermes:hermes-android:250829098.0.17`. The matching `libjsi.so` lives in
`android/runtime/src/main/jniLibs/arm64-v8a/`.

Hermes' own headers include `<jsi/jsi.h>`, but the Hermes AAR doesn't ship them (verified 2026-10-27).
**Headers, `libjsi.so`, `libhermesvm.so` and `hermesc` must all come from the same release.** When upgrading Hermes,
replace all four together.
