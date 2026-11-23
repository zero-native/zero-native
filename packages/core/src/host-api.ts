// The version of the JS ↔ native contract this `@zeronative/core` relies on: the `__zn_*` host functions, app event
// numbers, the batch and value formats. It equals kHostApiVersion in core/include/zn/engine.h less its native-only
// steps (NATIVE_ONLY_HOST_API; a test checks).
// The build writes it into each bundle's requirements, so an OTA bundle never runs on an app whose native side is
// older than the core it was built with (docs/ota.md §3.2). No side effects: the compiler imports this file.

export const HOST_API_VERSION = 9 // 2: NAV FAILED, app event RETRY (step 3.9); 3: NAV STARTED (step 4.7); 4: NAV RESTORE,
// START "values" (restorableSignal); 5: app event APP_STATE (H.7); 6: app events NAV_RESULT, TASK, COLOR_SCHEME, LOW_MEMORY;
// 7: app events DEVICE, WINDOW, KEYBOARD (RN basics pack); 8: tabs: NAV BACK_WANTED, route "tabs" in the manifest, a
// link to the start route keeps its params; 9: NAV LAYER (startApp's top and overlay)

/**
 * Host API steps only the native side takes: the app says the number (its capabilities), but nothing in the JS ↔
 * native contract changed, so bundles don't need it and keep running on older apps. 10: iOS has the Motion engine
 * (an iOS app at 9 or less has a stub; the update server keeps bundles that use Motion from it, tools/ota/decide.ts).
 * The next contract change skips these numbers (JS and native both go to 11).
 */
export const NATIVE_ONLY_HOST_API: readonly number[] = [10]
