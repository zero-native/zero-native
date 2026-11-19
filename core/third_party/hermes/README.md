# Hermes headers

The 8 headers `core/src/hermes_engine.cpp` needs from Hermes (`<hermes/hermes.h>` and what it includes), copied from
Meta's `hermes-ios` 260318099.0.5 release tarball (`destroot/include`, the same in the debug one). Only the Swift
package (`Package.swift`) reads them: Meta's `hermesvm.xcframework` carries no headers, and an app that adds the package
doesn't have `ios/third_party`. The CMake builds read the full `include/` of the fetched Hermes, as before.

`<jsi/jsi.h>` comes from `core/third_party/jsi`. **These, the JSI headers, `libjsi.so`, the Hermes runtimes and
`hermesc` must all come from the same release** (`core/third_party/jsi/README.md`): when upgrading Hermes, copy these
again from the new tarball (`bun run tools/fetch-hermes-apple.ts release`, then `ios/third_party/hermes/release/destroot/include/hermes`).

MIT License, Meta Platforms, Inc. and affiliates: `LICENSE`.
