# @zero-native/lottie

Lottie animations (`.json` and `.lottie` files from After Effects or LottieFiles), with lottie-react-native's names, so
ported code keeps its props: `<LottieView source autoPlay loop speed progress onAnimationFinish />`.

Drawing is Airbnb's `lottie-compose` 6.7.1 (the same Lottie 6.x that lottie-react-native 7.x uses on Android), inside
the APK. Nothing is downloaded from Play, and nothing comes from the network.

## Add it

1. `package.json`: add `"@zero-native/lottie": "workspace:*"`.
2. `android/settings.gradle.kts`: include `:plugin-lottie` and set its `projectDir` to `../plugins/lottie/android`
   (`docs/guide-notes.md` §30).
3. The app's `build.gradle.kts`: `implementation(project(":plugin-lottie"))`.
4. `Application.onCreate`, first thing: `ZnPlugins.register(this, LottiePlugin())`
   (`import dev.zeronative.plugins.lottie.LottiePlugin`).

No permission and no manifest entries. No R8 rule is needed (checked in a release build, see Size).

Put the files in your app's `assets/` folder, for example `assets/lottie/receipt_loading.lottie`. They ship in the
bundle, so an OTA update can change or add them, like `asset:` images.

## Use it

```tsx
import LottieView from "@zero-native/lottie"
import { View } from "@zero-native/ui"

// RN: <LottieView source={require("./receipt_loading.lottie")} autoPlay loop style={{ width: 140, height: 140 }} />
export function Waiting() {
  return (
    <View style={{ width: 140, height: 140 }}>
      <LottieView source="asset:lottie/receipt_loading.lottie" autoPlay loop />
    </View>
  )
}
```

Two changes from RN code, both on purpose:
- **`source`** is an `asset:` path (or `{ uri: "asset:..." }`), not `require(...)`. `require` of a file is a build error in zn.
- **The size goes on a `View` around it.** `LottieView` fills its parent. `style` on it is a type error. Why: layout is
  fixed at build time, and a component can't pass a style through (`docs/guide-notes.md` §57).

### Play, pause and reset from code: `ref`, as in RN

```tsx
import LottieView from "@zero-native/lottie"
import { useRef } from "@zero-native/core"

const anim = useRef<LottieView | null>(null)
// ...
<LottieView ref={anim} source="asset:lottie/green_earth.lottie" autoPlay={false} loop />
// later:
anim.current?.reset()
anim.current?.play()
```

A callback ref works too: `ref={(view) => (view ? refs.set(i, view) : refs.delete(i))}`. The ref gets `null` when the
view goes. `LottieView` is also the ref's type, as in RN.

## API

**`<LottieView>`** props (defaults as in lottie-react-native):

| Prop | Default | What |
|---|---|---|
| `source` | | `"asset:lottie/x.json"`, `"asset:lottie/x.lottie"`, or `{ uri }` with the same text. `null` shows nothing. |
| `autoPlay` | `false` | Plays when the file is loaded, from the start. |
| `loop` | `true` | |
| `speed` | `1` | Below 0 plays backwards. The phone's animator scale applies too, as for Android's own animations. |
| `progress` | `0` | 0 to 1. A new value jumps there; a play goes on from there. |
| `resizeMode` | `"contain"` | `"cover"`: fills the box, cut at the sides. `"center"`: its own size, in the middle. |
| `renderMode` | `"AUTOMATIC"` | `"HARDWARE"`, `"SOFTWARE"`. `hardwareAccelerationAndroid` is `"HARDWARE"`. |
| `colorFilters` | `[]` | `[{ keypath: "Layer", color: "#FF0000" }]`: paints that layer and everything under it. |
| `enableMergePathsAndroidForKitKatAndAbove`, `applyOpacityToLayersAndroid`, `enableSafeModeAndroid`, `cacheComposition` | as RN | Passed to Lottie. |
| `onAnimationLoaded()` | | The file is loaded. |
| `onAnimationFinish(isCancelled)` | | A play without `loop` reached its end (`false`), or `reset()` stopped a running play (`true`). |
| `onAnimationFailure(error)` | | `error` is one of: `not_found` (no such file in the running bundle), `bad_source` (not an `asset:` path), `broken` (not a Lottie file), `failed`. The box stays empty. |
| `ref` | | Gets the controller: `play(startFrame?, endFrame?)`, `pause()`, `resume()`, `reset()`. |
| `testID` | | Accepted, not used. |

Controller methods, as in RN on Android:
- `play()`: plays on from where it is (from the start if it is at the end). `play(10, 40)`: plays frames 10 to 40 from
  frame 10; `play(40, 10)` plays them backwards. Both frames are needed, else it is a plain `play()`.
- `pause()`: stops where it is, no event. `resume()`: plays on.
- `reset()`: stops at the start. A running play ends with `onAnimationFinish(true)`.
- Calls in the same tick count together: `reset(); play()` starts again from the start.
- A play without `loop` that reached its end is over, as on RN: a new `progress` then only shows that frame, and the
  next `play()` starts again from the start.

**`Lottie.preload({ source })`** reads and parses a file now, off the main thread, so a view that shows it later draws
at once. It answers `{ ok: true, width, height, durationMs, frames, frameRate }` or `{ ok: false, reason }`; it never
rejects. Views and `preload` share Lottie's cache of 20 animations. Low memory empties the cache.

## What happens by itself

- **"Remove animations" on** (Accessibility, or battery saver): a play shows its last frame at once (the first, when it
  plays backwards), and a play without `loop` sends `onAnimationFinish(false)` at once. A file with a "reduced motion"
  marker shows that marker's frame. It is read again when the app comes back to the front.
- **The app in the background:** no frames are drawn, so no CPU. Compose stops its frame clock.
- **A screen pushed on top:** the covered screen is not drawn, so its animations stop. Coming back makes the view
  again: `autoPlay` plays from the start; a view that was paused by `pause()` stays paused (the ref's state is in JS).
- **Files are parsed on one `zn-lottie` thread**, never on the main thread. Four Welcome slides parse one after the
  other. The first frame shows when its file is parsed (a few ms for a small file).

## Not supported (yet)

- Network URLs (`{ uri: "https://..." }`). Lottie would use its own HTTP client, outside the app's `fetch` setup
  (pins, interceptors). Put the file in `assets/` instead.
- `require("./x.json")` and a JSON object as `source`; `duration` (it needs the object).
- `imageAssetsFolder` (JSON with image files next to it). Images inside the file (base64) and inside a `.lottie` work.
- `textFiltersAndroid` / `textFiltersIOS`, `onAnimationLoop`, `onLayout`, `containerStyle`, `webStyle`, `hover`.
- A `.lottie` file with more than one animation: Lottie shows one of them.
- iOS.

## Size

Measured on the sample (release, R8, arm64), 2026-11-05: **+85 KB** in the APK for the plugin
(`classes.dex` +83.6 KB compressed, `resources.arsc` +0.5 KB), plus your own files. ZeroBill's `.lottie` files are 1 to
28 KB each. lottie brings appcompat 1.6.1 with it; R8 removes it, as the sample shows no new appcompat classes. Checked
with dexdump: 161 Lottie classes and the plugin's 14 classes are kept, and every lab case works in the R8 release build
on the Android 13 emulator, so no R8 rule is needed.

**Start time:** the plugin does no work at start (`register` makes 3 small objects; Lottie's classes load with the
first view). On the emulator, 2 × 10 cold starts each gave a median of 1631 ms without it and 1668 ms with it, inside
the emulator's noise. Not measured on a phone yet.
