# @zeronative/core

The JS side of the [zero-native](https://github.com/zero-native/zero-native) runtime: signals, navigation
(`nav`), storage, `fetch`, timers, OTA updates and the calls to native code. Screens import it next to
`@zeronative/ui`:

```tsx
import { nav, signal } from "@zeronative/core"
import { Pressable, Text, View } from "@zeronative/ui"
```

How an app is built and run: the [README](https://github.com/zero-native/zero-native#readme) of the repo.
Apache-2.0.
