# MMKV's public headers, for the Swift package

`MMKV/` holds copies of the 5 headers that MMKV's own CMake file copies into `Core/include/MMKV/` each time CMake
configures (`copy_files` in `Core/CMakeLists.txt`). That folder is in MMKV's `.gitignore`, and SwiftPM runs no CMake,
so `Package.swift` (the `ZnMMKV` target) reads these copies instead. `Core/` stays exactly as upstream.

When upgrading MMKV, copy the 5 headers again from `Core/`: `tools/test/swift-package.test.ts` fails while any copy
differs.
