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
| `layout` | layout values from a slot (`ZnDynamicValues.swift`) | `ZnRenderer.kt`, `ZnTouch.kt` |
| `ota` | OTA rules and the zip install (`ZnOtaRules.swift`, `ZnOtaInstall.swift`) | `ZnOtaHealthTest`, `ZnBundlesTest`, `ZnOtaStoreTest`, `ZnOtaSignatureTest`, `ZnOtaInstallTest` |
| `routes` | route reading and deep link matching (`ZnRoutes.swift`) | `ZnRoutesTest.kt`, `ZnNavHost.kt` |

## Adding a suite

1. Make `ios/tests/<suite>/`.
2. `sources.txt`: the Swift files to build with it, one per line, from the repo root. Blank lines and lines starting
   with `#` are skipped. Don't list `main.swift`; the runner adds it. The files must build without UIKit, SwiftUI or
   Hermes; if one needs them, move the plain part into its own file (as `ZnRoutes.swift` and `ZnDynamicValues.swift`
   are).
3. `main.swift`: the checks. Print each failure with its line, print a last line with the count, and exit 0 when
   everything passed and 1 when anything failed (copy the `check` / `test` helpers from `layout` or `routes`).
4. Optional `args.txt`: the program's arguments, one per line. A path is from the repo root and must exist before the
   build (the runner says which is missing, with the file's `#` lines as the hint). `$WORK` is the suite's scratch
   folder, made fresh for each run and removed after.
5. Optional `setup.ts`: run first as `bun run setup.ts $WORK/setup` to make fixtures there (see `ota/setup.ts`).
6. Run `bun run tools/ios-unit-test.ts <suite>`, then break one check on purpose and see it fail.

The bun test and CI pick a new suite up without any change. Add it to the table above.
