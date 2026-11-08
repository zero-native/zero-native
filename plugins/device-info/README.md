# @zero-native/device-info

[react-native-device-info](https://github.com/react-native-device-info/react-native-device-info) for zero-native apps,
on Android: the same names, the same values, the same "don't know" answers. Code that used it should need only the
import changed:

```ts
import DeviceInfo from "@zero-native/device-info"   // or: import { getVersion, getUniqueIdSync } from "@zero-native/device-info"

const BASE_URL = DeviceInfo.getBundleId() === "com.example.app" ? "https://api.example.com" : "https://dev.example.com"
const deviceId = DeviceInfo.getUniqueIdSync()
const level = await DeviceInfo.getBatteryLevel()
```

## How "sync" works
Values that can't change while the app runs (the app's id and version, the phone's model, ANDROID_ID, ...) are read by
native **before the app's JS starts** and handed to JS with the bundle (core's `nativeConstants`, RN's `getConstants`).
So the plain getters and the `...Sync` getters answer at once, also at module level, as in RN. Reading them costs
nothing after the first one. Native reads them once per start: a few cheap system calls (logged as
`zn-device-info: constants read in N ms`).

Values that change (battery, disk, network, settings) are calls: a Promise, as in RN.

Nothing rejects and nothing throws. A value the phone doesn't give answers what react-native-device-info answers then:
`"unknown"`, `-1`, `false` or `[]`. An app whose APK doesn't have this plugin yet answers the same way, so always treat
"unknown" as "unknown" (for example: production only on an exact match of `getBundleId()`).

## Add it
1. In `settings.gradle.kts`: `:plugin-device-info` → `../plugins/device-info/android`.
2. In the app's `build.gradle.kts`: `implementation(project(":plugin-device-info"))`.
3. In `Application.onCreate`, with the other plugins: `ZnPlugins.register(this, DeviceInfoPlugin())`.

No permission. The manifest lists Google Play services and Huawei's services in `<queries>` (for `hasGms` / `hasHms`).

## What differs from react-native-device-info
| Call | Here |
|---|---|
| `getUniqueId` / `getUniqueIdSync` | Android's ANDROID_ID, as RN gives on Android: one value per signing key, user and phone. The same app signed with the same key reads the same value as its RN version did |
| `getBatteryLevelSync`, `getFreeDiskStorageSync`, `getPowerStateSync`, `isAirplaneModeSync` and the other `Sync` forms of **changing** values | Not here: use the Promise form. A sync read of a changing value would need a blocking call into native; zero-native has none on purpose |
| `hasNotch` | From the screen's real cut-out (Android 10+), not RN's list of phone models. Older phones: false |
| `getDeviceName` | RN's order: the Bluetooth name (Android 12 and older), then the phone's name in settings. Read once at start |
| `getInstallReferrer` | `"unknown"`: it needs Google's install referrer library. Apps that need it read it in their own plugin |
| `getMacAddress`, `getSerialNumber`, `getPhoneNumber` | What Android gives apps today: `"02:00:00:00:00:00"`, `"unknown"`, `"unknown"` (as RN without the permissions) |
| `getIpAddress` | The active network's IPv4 address (Wi-Fi or mobile), `"0.0.0.0"` with none |
| `getFreeDiskStorage(type)`, `getTotalDiskCapacity` | The app's data partition. The `type` argument is ignored |
| Hooks (`useBatteryLevel`, `usePowerState`, ...) and change events | Not built. Read the Promise form when you need it |
| iOS / Windows-only calls (`getBrightness`, `isKeyboardConnected`, `hasDynamicIsland`, ...) | On Android, RN's Android answers: `-1` / `false`. On iOS, `getBrightness`, `hasDynamicIsland` and `isDisplayZoomed` are real |

## Privacy
`getUniqueId`, `getDeviceName` and `getCarrier` are personal data in some places. Don't log them, and say what you
send to your server.
