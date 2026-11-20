# zero-native's Lottie plugin as a Swift package

`ZnPluginLottie` (`plugins/lottie`), with Lottie from `lottie-spm`. A package of its own so an app without Lottie never
downloads it. `Sources/ZnPluginLottie` is a symlink to `plugins/lottie/ios`, where the CMake builds compile the same
code. Here it depends on the main package by path (`../../..`). Apps get a copy in its own repo, `zero-native-lottie`,
made at each release by `tools/make-plugin-packages.ts`, with `README.release.md` as its README (`docs/releasing.md`).
Lottie comes as a dynamic framework here; the CMake builds link Lottie-Static.
