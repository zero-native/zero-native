# iOS unit tests on the Mac

Each folder here is a suite: plain Swift files from `ios/ZnRuntime/Swift` built with `swiftc` together with the
suite's `main.swift`, and run as a Mac program. No simulator, no Xcode project, no Hermes. They check the parts of
the runtime that need only Foundation (and CryptoKit, Compression or CoreGraphics), often against the same cases as
Android's JVM tests, so the two copies can't drift apart silently.

Run them:

```sh
bun run tools/ios-unit-test.ts             # every suite (also: bun run ios:unit-test)
bun run tools/ios-unit-test.ts ota routes  # just these
```

`bun run test` runs them too on a Mac with Xcode (`tools/test/ios-unit.test.ts`, one test per suite), and CI's `ios`
job runs `bun run tools/ios-unit-test.ts`. Elsewhere the bun test skips them.

Some suites read built files: `routes` reads the sample's `main.zn.ui.json`, so run `bun run sample:js` first.

## The suites

| Suite | Checks | Android's side |
|---|---|---|
| `dev` | `zn dev`'s frames (length counts the type byte, big endian), a BUILD frame's parts and a cut one refused, the build folders (three files, older ones go, the running one stays, hex names only) (`ZnDevWire.swift`) | `ZnDev.kt`, `tools/zn-dev.ts` |
| `draw` | the <Canvas> command parser (every case of Android's tests), its path data, and the drawing: pixels of shapes, gradients (sweep from 12 o'clock), clips, dashes, trims, blend modes in their own layer, shadows and blur, text and paragraphs, images and their decode size (`ZnCanvasParse.swift`, `ZnCanvasDraw.swift`, `ZnPathData.swift`) | `ZnCanvasTest.kt`, `ZnCanvas.kt`, `ZnCanvasImage.kt` |
| `element` | useElementMotion's plain rules: a List's index / offset at a scroll position (Android's lazy items: header, empty, rows or grid lines, footer), follow by item and by page, a Carousel's page, pull's share of the refresh line (`ZnElementRules.swift`) | `ZnRenderer.kt` (ZnLazyList, ZnCarousel), `ZnMotionUi.kt`, `ZnPullRefresh.kt` |
| `gestures` | gesture options and releases (coordinates, rubber, anchors by flick / distance / nearest, magnets, progress, drop zones, requireToFail; the fling projection is iOS's), the velocity tracker, and made-up finger streams through one node's touch session: pan slop, axis, offsets, bounds, anchors, magnets, crosses, cancel and snapTo, resting on a moving anchor; tap, double tap, exclusive / race / simultaneous groups, pinch, rotation, long press, fling, manualActivation, simultaneousWith (`ZnGestureMath.swift`, `ZnVelocityTracker.swift`, `ZnGesture.swift`, `ZnGestureRecognizers.swift`) | `ZnMotionTest.kt`, `ZnGesture.kt` |
| `impressions` | impressions on a fake clock: threshold 0.35 (clamped 0.01–1), minMs, only on the top screen and in front, once per visit, 500 ms batches, a flush when going to the back, release, reset for a reload (`ZnImpressionsCore.swift`) | `ZnImpressions.kt` |
| `layout` | layout values from a slot (`ZnDynamicValues.swift`) | `ZnRenderer.kt`, `ZnTouch.kt` |
| `lifecycle` | WINDOW's text (fixed key order, one decimal for sizes, exact scale and font scale), the keyboard's height from its layout guide, and when START goes (JS first or the window first) (`ZnLifecycleRules.swift`) | `ZnWindowTest.kt`, `ZnRuntime.kt` / `ZnNav.kt` start order |
| `list` | `<List>`'s item order (header, empty, rows, footer), grid lines, the visible range, splices and scroll command targets (`ZnListLogic.swift`, `ZnScrollCommand.swift`) | `ZnRenderer.kt` (`ZnLazyList`) |
| `net` | fetch's progress throttle, the multipart body writer (streamed file parts, escaping, cancel, a 100 MB file's memory) and the network key (`ZnNetRules.swift`) | `ZnFetchTest.kt` (ProgressThrottler), OkHttp's `MultipartBody` |
| `ota` | OTA rules and the zip install (`ZnOtaRules.swift`, `ZnOtaInstall.swift`) | `ZnOtaHealthTest`, `ZnBundlesTest`, `ZnOtaStoreTest`, `ZnOtaSignatureTest`, `ZnOtaInstallTest` |
| `motion` | motion maths, `derive()` formulas and the motion engine's commands, watch and follow, on a fake frame clock; the 3D turn's matrix against HWUI's order and enter / exit's values; what a bound slot reads (references, motion colours, `self` / `parent` sizes, motion text, blur, corner precedence) (`ZnMotionMath.swift`, `ZnFormula.swift`, `ZnMotionEngine.swift`, `ZnDepth.swift`, `ZnMotionBindRules.swift`) | `ZnMotionTest.kt`, `ZnMotion.kt` |
| `scroll` | a Scroll's snap rules and pick, the events JS wants and onScroll's throttle, the event JSON, where a ref command goes, keyboardDismissMode (`ZnScrollSnap.swift`, `ZnScrollCommand.swift`) | `ZnScrollExtras.kt` (ZnSnap, ZnScrollWants, znSendScroll, ZnScrollCommands), `ZnKeyboardScroll.kt` |
| `routes` | route reading and deep link matching (`ZnRoutes.swift`) | `ZnRoutesTest.kt`, `ZnNavHost.kt` |
| `push` | a background push's once-only answer and a task's answer-by time (`ZnTaskRules.swift`), the Crashlytics plugin's bundle keys and reasons (`plugins/firebase-crashlytics/ios/CrashlyticsRules.swift`) | `ZnBackground.kt`, `CrashlyticsRulesTest.kt` |
| `svg` | the SVG filter graph: the region in pixels and its caps, blur sigma (round, one side, big), offsets, flood, colour matrices on unpremultiplied colour (greyscale, the gooey alpha), composites with src = in and dst = in2 (in, out, atop, xor, plus, in2 minus in), blends with alpha, merge order, SourceAlpha, sRGB maths, a drop shadow, bad graphs, matrix values too big for vImage, the hook's maths (region on device pixels, flips, a turn, a mirror, nested, lower resolution, fallback) (`ZnSvgFilters.swift`) | `ZnSvgEffects.kt` (ZnSvgFilterGraph) |
| `text` | the text scale with maxFontScale, the font table, the font file check, the face a weight and style pick (CSS), the phone's font names, and the sample's font files loaded with their weights (`ZnFontRules.swift`) | `ZnTemplate.kt` fontScaleCap, `ZnFontsTest.kt`, Compose's font matching |
| `uirules` | Carousel page width, Text auto-fit scale, TextField capitalization and autocorrect (`ZnUIRules.swift`) | `ZnRenderer.kt`, `ZnTextField.kt` |
| `plugins/app-updates` | versions, the iOS a build needs, staleness, the App Store lookup's URL and answer, isUpdateAvailable's shape, the cache, the sheet's state and re-open rules (`plugins/app-updates/ios/AppUpdatesRules.swift`) | `AppUpdatesRules.kt` |
| `plugins/document-scanner` | the job record, options, collect, file names, cleanup, Camera or Photos, the picker's limit, the mode for imported pages, Vision's corners (`plugins/document-scanner/ios/DocScanRules.swift`) | `DocScanRulesTest.kt` |
| `plugins/image-viewer` | links, data: links, headers (CR and LF by scalar), the fit, the visible area under a zoom, snapping, when a sharp part is needed, every nth pixel, EXIF turns and the stored rectangle; the page's decoding on real JPEGs: the fitted copy upright for EXIF 1, 3, 6, 8 and a mirror, sharp parts matching the upright picture, none for a mirror, and a part of an 8000 × 6000 JPEG without decoding the whole picture (`plugins/image-viewer/ios/ViewerRules.swift`, `ViewerSource.swift`) | `ViewerRulesTest.kt`, `SharpSource.kt` |
| `plugins/webview` | links, hosts, schemes, origins, the page check, the upload count and the scripts' host JSON (`plugins/webview/ios/WebViewRules.swift`) | `WebViewRulesTest.kt` |

A plugin's suite sits one level down, in `ios/tests/plugins/<plugin>`, and is named `plugins/<plugin>`.

## Adding a suite

1. Make `ios/tests/<suite>/`.
2. `sources.txt`: the Swift files to build with it, one per line, from the repo root. Blank lines and lines starting
   with `#` are skipped. Don't list `main.swift`; the runner adds it. The files must build without UIKit, SwiftUI or
   Hermes; if one needs them, move the plain part into its own file (as `ZnRoutes.swift` and `ZnDynamicValues.swift`
   are). Only `.swift` files: the runner refuses anything else. C, C++ and Objective-C++ (`core/`, `ZNHost.mm`, the
   storage and runtime headers) are tested in `core/tests/core_tests.cpp` instead, with
   `bun run tools/run-core-tests-apple.ts`.
3. `main.swift`: the checks. Print each failure with its line, print a last line with the count, and exit 0 when
   everything passed and 1 when anything failed (copy the `check` / `test` helpers from `layout` or `routes`).
4. Optional `args.txt`: the program's arguments, one per line. A path is from the repo root and must exist before the
   build (the runner says which is missing, with the file's `#` lines as the hint). `$WORK` is the suite's scratch
   folder, made fresh for each run and removed after. A line starting with `-` is passed as it is (a flag such as
   `--seed=3`); any other value has to be a path.
5. Optional `setup.ts`: run first as `bun run setup.ts $WORK/setup` to make fixtures there (see `ota/setup.ts`).
6. Run `bun run tools/ios-unit-test.ts <suite>`, then break one check on purpose and see it fail.

The bun test and CI pick a new suite up without any change. Add it to the table above.
