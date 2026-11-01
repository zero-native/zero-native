# zero-native (`zn`)

A mobile UI framework: screens in TypeScript + TSX, drawn by native Jetpack Compose (SwiftUI later), logic in Hermes
without React or React Native, OTA updates, and payment flows that survive the app being killed.

**Status (2026-10-31):** milestones 1–4 are built on Android: foundations, an app (navigation, lists, sheets,
native modules, FlowStore), real-app essentials (dev reload, text fields, `fetch`, storage, animation, resilience),
and signed OTA updates with safety nets. Next: the plugin system (`docs/plugins.md`, a proposal), then the ZeroBill
checkout pilot. iOS is not started. Progress: `docs/milestones.md`.

- Spec and decisions: `ARCHITECTURE.md`
- Detailed rules and reading order: `docs/README.md`
- History: `story.md`
- v0 experiments (reference only): `experiments/`

Build and run the sample app: see `docs/milestones.md` ("How to build and run the sample").
