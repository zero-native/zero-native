# Third-party notices

zero-native is under the Apache License 2.0 (see `LICENSE`). It includes or is built with the parts below,
each under its own license.

- **JSI headers from React Native (Meta Platforms, Inc. and affiliates)** (`core/third_party/jsi`): MIT License. See `core/third_party/jsi/README.md` for the version.
- **libjsi.so from `com.facebook.react:react-android` (Meta Platforms, Inc. and affiliates)** (`android/runtime/src/main/jniLibs`): MIT License.
- **MMKV (Tencent)** (`core/third_party/mmkv`): BSD 3-Clause, with parts under other licenses: `core/third_party/mmkv/LICENSE.TXT`.
- **svg-loaders** (`compiler/test/fixtures/animated-svg/svg-loaders`): see `compiler/test/fixtures/animated-svg/svg-loaders/LICENSE.md`.
- **svg-spinners** (`compiler/test/fixtures/animated-svg/svg-spinners`): see `compiler/test/fixtures/animated-svg/svg-spinners/LICENSE`.
- **loaders** (`examples/sample/src/svg/loaders`): see `examples/sample/src/svg/loaders/LICENSE`.

Build and runtime dependencies fetched by Gradle, SwiftPM or Bun (Hermes, Compose, OkHttp, Coil, Firebase, ...) keep
their own licenses and are not copied into this repository.
