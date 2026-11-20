# zero-native Documentation

Welcome! Whether you're building your first `zero-native` app, migrating from React Native or Flutter, or setting up self-hosted OTA updates, start with the guides below.

---

## Guides (Start Here)

- **[Getting Started](guides/getting-started.md)** — Install prerequisites, scaffold an app with `zn new`, run on Android & iOS, and use live reload.
- **[Core Concepts](guides/core-concepts.md)** — Signals, once-run components, JSX rules, control flow, event handling, and lifetimes.
- **[Styling & Layout](guides/styling-and-layout.md)** — The `style` prop, fixed modifier order, flex rules, safe areas, dark mode, and dynamic styles.
- **[Components](guides/components.md)** — Overview of layout, text & spans, inputs & OTP, virtualized `<List>`, `<Sheet>`, `<Modal>`, `<Image>`, `<Svg>`, `<Canvas>`, `<Tabs>`, and accessibility.
- **[Navigation](guides/navigation.md)** — Typed routes, stack actions, bottom tabs, deep links, back handlers, process-death restoration, and splash holds.
- **[Data & Networking](guides/data-and-networking.md)** — `fetch`, `WebSocket`, synchronous `storage` (MMKV), `SecureStore`, and crash-safe `FlowStore`.
- **[Motion & Gestures](guides/motion-and-gestures.md)** — State-driven animations, `enter`/`exit` transitions, UI-thread motion values, `derive()`, gestures, and shared elements.
- **[Plugins](guides/plugins.md)** — Using the 20 official plugins and building your own native modules, views, or screens.
- **[OTA Updates & `zn-updates` Server](guides/ota-updates.md)** — Contract-based bundles, ECDSA signing, rollouts, rollback, CLI workflow, and self-hosting the update server.
- **[Coming from React Native](guides/coming-from-react-native.md)** — The four mental shifts, side-by-side cheat sheet, and common porting gotchas.
- **[Coming from Flutter](guides/coming-from-flutter.md)** — Mapping widgets, state, lists, navigation, and native OTA.
- **[Platform Differences & Parity](guides/platform-differences.md)** — Honest Android vs. iOS behavior differences and current iOS parity status.
- **[Contributing](guides/contributing.md)** — Building from source, running tests, and OTA-safe registry rules.

---

## Deep Reference

Detailed technical specifications, exhaustive prop/API tables, and runbooks:

- **Architecture & Spec:** [ARCHITECTURE.md](../ARCHITECTURE.md) (overview), [architecture-spec.md](architecture-spec.md) (full v1 spec, §22 origin diff, and §24 decision log)
- **App Author Reference:** [guide-notes.md](guide-notes.md), [components.md](components.md), [styling-and-layout.md](styling-and-layout.md), [rn-compatibility.md](rn-compatibility.md), [platform-differences.md](platform-differences.md), [svg.md](svg.md), [lists.md](lists.md), [fetch.md](fetch.md), [storage.md](storage.md), [motion.md](motion.md), [gestures-and-motion-v1.md](gestures-and-motion-v1.md)
- **Plugins & Native Internals:** [plugins.md](plugins.md), [native-modules.md](native-modules.md), [adding-components.md](adding-components.md), [startup-and-performance.md](startup-and-performance.md), [android-issues-found-when-building-ios.md](android-issues-found-when-building-ios.md)
- **OTA & Update Server:** [ota.md](ota.md), [ota-patches.md](ota-patches.md), [ota-requires-per-os.md](ota-requires-per-os.md), [ota-test-matrix.md](ota-test-matrix.md), [zn-updates-server.md](zn-updates-server.md), [zn-updates-deploy.md](zn-updates-deploy.md)
- **Road to 1.0:** [production-readiness.md](production-readiness.md), [publishing-plan.md](publishing-plan.md), [releasing.md](releasing.md)

---

## Project History

- **[The Story of zero-native](../story.md)** — Why we built it and the experiments that shaped it.
- **[milestones.md](milestones.md)** — Step-by-step build log and measurements.
- **[milestones-ios.md](milestones-ios.md)** — iOS track history and status.
- **[second-opinions.md](second-opinions.md)** — 230+ engineering judgment calls written up for outside review.
