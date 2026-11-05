# zero-native docs: start here

zero-native (`zn`) is a mobile UI framework: screens in TypeScript + TSX, drawn by native Jetpack Compose (and
SwiftUI later), logic in Hermes without React or React Native, OTA updates, and payment flows that survive the app
being killed. ZeroBill is its first user; it is a long-term community project and ZeroBill must not depend on it
until it is proven.

## Reading order for a new session
0. **`milestones.md`**: where the build stands right now and what's next.
1. **`../ARCHITECTURE.md`**: the spec and the source of truth. Decision log in §24.
2. The detailed spec files below, for the part you are working on.
3. **`v0-findings.md`**: every bug and lesson from the v0 experiments. Read the matching section before building
   any part.
4. `../story.md`: history, how we got here, project framing and status.
5. Raw evidence, only when needed: `../experiments/RESULTS.md`, `../experiments/exp-notes/`, `../experiments/gemini-flash-individual-experiments/`.

## Reading order for an outside reviewer (state on 2026-11-04)
1. `../ARCHITECTURE.md`: "Where things stand" at the top, then the spec. Sections marked **As built** say what the
   code does today; §24 is the decision log, §25 the open questions.
2. `milestones.md`: the step tables (what is done, what moved), then the log at the bottom for details per step.
3. `ota.md` + `ota-test-matrix.md`: the OTA design and the 38 phone tests.
4. `plugins.md`: the plugin system. P.1 to P.6 are built, with the official plugins (`../plugins/<name>/README.md` for each). Decisions D1–D7 were taken on 2026-11-02.
5. `second-opinions.md`: judgment calls we want checked.
6. `guide-notes.md`: what we tell app authors (do / don't / why).

## Detailed spec files
| File | What it covers |
|---|---|
| `styling-and-layout.md` | `style` props, supported keys, the fixed modifier order, zn flex rules, safe areas |
| `lists.md` | `<For>` vs `<List>`, the window protocol, placeholders, the fast template interpreter, native data source (v1.1) |
| `native-modules.md` | calling native code from JS and back (RN TurboModules / Flutter channels equivalent): typed modules, events, cancellation, binary data built; built-in modules moved to `plugins.md` |
| `plugins.md` | how plugins (native modules + native views + native screens) are written and shipped, the official plugins (built: `auth`, `scanner`, `media`, `webview`, `pdf`, `location`, `firebase-app`, `crashlytics`, `push`, `analytics`, `remote-config`, `perf`), core plumbing (permissions, results from other apps), decisions D1–D7, steps P.1–P.6 (all built) |
| `svg.md` | **phases 1–4 built (2026-11-03, registry 13):** first-class SVG: `.svg` imports, inline `<Svg>`, parts, the supported subset, build-time draw data, motion, animated files, effects |
| `components.md` | reference for the small components (Switch, Checkbox, Spinner / Progress, Toast, image fallback), accessibility props, tabs, SVG, and the React Native props (`Modal`, `StatusBar`, `pointerEvents`, ...) |
| `startup-and-performance.md` | startup rules and budget, how to measure, every number measured so far |
| `platform-differences.md` | known differences between Android, iOS and React Native semantics |
| `rn-compatibility.md` | React Native components, style keys, navigation, storage, `fetch`, `Linking`, permissions and native modules mapped to zero-native, each with a status (same / renamed / different / missing) and how to move; ends with the 10 costliest gaps |
| `v0-findings.md` | lessons and bugs from v0 (and from building v1, §P), with where the spec handles each |
| `fetch.md` | `fetch`: design, defaults, and the production problems (RN / Flutter / OkHttp) it handles |
| `ota.md` | OTA updates (milestone 4): design, decisions D1–D5 (taken 2026-10-30), steps 4.0–4.9 (all done 2026-10-31) |
| `ota-test-matrix.md` | the OTA phone test script (`bun run ota:phone`), its 38 cases and results on the Lava, and what it can't test |
| `second-opinions.md` | judgment calls made while building, written up for a bigger model or an expert to check |
| `hardening-plan.md` | the fixes made before the plugin work (H.1–H.7), with risks and tests. All built 2026-11-02 |
| `storage.md` | app storage (MMKV, synchronous), SecureStore, and when a store can be lost |
| `hermes-features.md` | what Hermes 260318099 added (JSI runtime data, `ISerialization`, faster JSON, ...) and how we could use it later |
| `milestones.md` | **the build plan, progress log, and how to build and run the sample app** |
| `after-foundations.md` | parked ideas to pick up once the foundations work |
| `rn-compat-sweep.md` | where RN code could just work in zn (2026-11-05 sweep): silent differences to fix first, cheap RN names, bigger items; waits on Pavan's picks |
| `production-readiness.md` | what is left before apps with 10M+ users (Android at scale, iOS, security, CI), as a checklist with a step-by-step ladder |
| `adding-components.md` | **for framework developers:** adding a component, prop, event or host function without breaking OTA bundles on older apps (registry rules, `gen:registry`, id ranges) |
| `guide-notes.md` | **how app authors should use what we build** (do / don't / why): raw material for the public docs. Update it whenever an author-facing feature lands |

Experiment files (v0 results, Gemini and Argon reports, `intro*.md`, `GEMINI_*.md`, exp2–4) live in `../experiments/`.

## Rules for writing these docs
- Simple English, short sentences. Explain any term once.
- Mark facts: **decided**, **target** (not measured), **[check]** (believed, not confirmed).
- Every number says its build type, device and where the clock starts.
- When a decision changes, update `ARCHITECTURE.md` §24 (decision log) in the same change.
