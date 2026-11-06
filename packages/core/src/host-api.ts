// The version of the JS ↔ native contract this `@zero-native/core` relies on: the `__zn_*` host functions, app event
// numbers, the batch and value formats. It must equal kHostApiVersion in core/include/zn/engine.h (a test checks).
// The build writes it into each bundle's requirements, so an OTA bundle never runs on an app whose native side is
// older than the core it was built with (docs/ota.md §3.2). No side effects: the compiler imports this file.

export const HOST_API_VERSION = 9 // 2: NAV FAILED, app event RETRY (step 3.9); 3: NAV STARTED (step 4.7); 4: NAV RESTORE,
// START "values" (restorableSignal); 5: app event APP_STATE (H.7); 6: app events NAV_RESULT, TASK, COLOR_SCHEME, LOW_MEMORY;
// 7: app events DEVICE, WINDOW, KEYBOARD (RN basics pack); 8: tabs: NAV BACK_WANTED, route "tabs" in the manifest, a
// link to the start route keeps its params; 9: NAV LAYER (startApp's top and overlay)
