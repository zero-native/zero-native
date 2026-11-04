# zero-native (`zn`)

A mobile UI framework: screens in TypeScript + TSX, drawn by native Jetpack Compose (SwiftUI later), logic in Hermes
without React or React Native, OTA updates, and payment flows that survive the app being killed.

**Status (2026-11-04):** milestones 1–4 are built on Android: foundations, an app (navigation, lists, sheets,
native modules, FlowStore), real-app essentials (dev reload, text fields, `fetch`, storage, animation, resilience),
and signed OTA updates with safety nets. Since then: hardening (H.1–H.7), the plugin system (P.1–P.6: native modules,
native views, native screens, background JS), bottom tabs, pull to refresh, SVG (phases 1–4), React Native names for
props and handlers, and official plugins. The plugins are in `plugins/`: `auth`, `scanner`, `media`, `webview`, `pdf`,
`location`, and the Firebase ones: `firebase-app`, `crashlytics`, `push`, `analytics`, `remote-config`, `perf`
(`device-test` is a test plugin). Next: the ZeroBill checkout pilot (login, scan, UPI). iOS and the flow engine
(parked) are not built. Progress: `docs/milestones.md`.

- Spec and decisions: `ARCHITECTURE.md`
- Detailed rules and reading order: `docs/README.md`
- History: `story.md`
- v0 experiments (reference only): `experiments/`

Build and run the sample app: see `docs/milestones.md` ("How to build and run the sample").
