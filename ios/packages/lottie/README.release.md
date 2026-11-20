# zero-native: Lottie plugin for iOS

`ZnPluginLottie`: Lottie animations (`.json` and `.lottie`) for [zero-native](https://github.com/zero-native/zero-native)
apps, with lottie-react-native's names. A Swift package of its own so an app without Lottie never downloads it.

**Add it together with zero-native, at the same version.** It depends on `https://github.com/zero-native/zero-native.git`
at exactly its own version:

```swift
.package(url: "https://github.com/zero-native/zero-native.git", exact: "0.1.0"),
.package(url: "https://github.com/zero-native/zero-native-lottie.git", exact: "0.1.0"),
```

In Xcode: File → Add Package Dependencies, both urls, "Exact Version", the same number.

The code is made in the zero-native repo (`plugins/lottie/ios`) and copied here at each release: change it there, not
here. Apache-2.0 (`LICENSE`, `NOTICE`).
