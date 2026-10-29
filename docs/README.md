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

## Detailed spec files
| File | What it covers |
|---|---|
| `styling-and-layout.md` | `style` props, supported keys, the fixed modifier order, zn flex rules, safe areas |
| `lists.md` | `<For>` vs `<List>`, the window protocol, placeholders, the fast template interpreter, native data source (v1.1) |
| `startup-and-performance.md` | startup rules and budget, how to measure, every number measured so far |
| `platform-differences.md` | known differences between Android, iOS and React Native semantics |
| `v0-findings.md` | lessons and bugs from v0 (and from building v1, §P), with where the spec handles each |
| `milestones.md` | **the build plan, progress log, and how to build and run the sample app** |
| `after-foundations.md` | parked ideas to pick up once the foundations work |
| `guide-notes.md` | **how app authors should use what we build** (do / don't / why): raw material for the public docs. Update it whenever an author-facing feature lands |

Experiment files (v0 results, Gemini and Argon reports, `intro*.md`, `GEMINI_*.md`, exp2–4) live in `../experiments/`.

## Rules for writing these docs
- Simple English, short sentences. Explain any term once.
- Mark facts: **decided**, **target** (not measured), **[check]** (believed, not confirmed).
- Every number says its build type, device and where the clock starts.
- When a decision changes, update `ARCHITECTURE.md` §24 (decision log) in the same change.
