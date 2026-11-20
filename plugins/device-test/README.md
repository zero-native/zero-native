# @zeronative/device-test

A test plugin, used by the sample app. It is never shipped in a real app. It is also the smallest full plugin, so copy it
when you start a new one (guide: [docs/plugins.md](../../docs/plugins.md)).

It adds the `Device` native module, version 6:

| Function | What it shows or tests |
|---|---|
| `info` | a plain call |
| `slowEcho` | a slow call that can be cancelled |
| `fail` | an error with a code |
| `storageEcho`, `storageHammer` | storage shared with JS |
| `crash` | debug builds only: crashes the app, to test the OTA watchdog |
| `openMockUpi` | debug builds only: opens the mock UPI app from `test-kit/`, never a real UPI app |
| `openMissingApp` | debug builds only: a launch of an app that isn't installed |
| `tick` event | an event that runs only while JS listens |

## How it is added to an app

1. `package.json`: `"@zeronative/device-test": "workspace:*"`.
2. `android/settings.gradle.kts`:
   ```kotlin
   include(":plugin-device-test")
   project(":plugin-device-test").projectDir = file("../plugins/device-test/android")
   ```
3. The app's `build.gradle.kts`: `implementation(project(":plugin-device-test"))`.
4. `Application.onCreate`, first thing: `ZnPlugins.register(this, DeviceTestPlugin())`.
