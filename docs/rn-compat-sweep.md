# RN-compat sweep (2026-11-05): where RN code could just work in zn

Pavan's ask (via the ZeroBill port): find where React Native code must be written differently in zn and could match
RN instead, **without changing zn's core ideas** (no React, compiled templates, signals, Compose).

Made by 3 read-only Sonnet 5.5 subagents (component props, styles and layout, JS APIs), merged and ranked by the
parent session. **[checked]** = the parent read the code itself. Everything else is the subagents' reading of the
code, not run, and must be checked again before it is built. Pavan said yes to P0 and P1 (2026-11-05). Rows marked **Done** are built.

Already done the same day (second-opinions 111): List padding scrolls with the rows, `contentContainerStyle` (padding
keys), Stack stretches its normal children.

**Labels:**
- Cost: **S** = under an hour, **M** = half a day, **L** = more.
- "Lands": where the change goes. Compiler-only changes need no new APK.
- Every row below is a **framework** item.
- Only P0 affects the pilot today. The rest wait.

---

## P0. Silent wrong results: fix first

These compile and then do the wrong thing with no message. That is the worst kind of difference for RN authors and LLMs.

| # | What happens | Fix | Lands | Cost | Blocks pilot? |
|---|---|---|---|---|---|
| 0.1 | **Done 2026-11-05 (second-opinions 112).** **`gap` is dropped when `justifyContent` is center, flex-end or space-\*** [checked: [ZnRenderer.kt:714-734](../android/runtime/src/main/java/dev/zeronative/runtime/ZnRenderer.kt:714)]. The ZeroBill prototype has 11 such rows (login, location prompt, rewards UseSheet, empty home tabs, footer), all drawn with no gap today | `spacedBy(gap, alignment)` for center / end; for space-\*, gap becomes the smallest space | runtime | S | **Yes, the look:** those 11 rows show no gap now |
| 0.2 | **Done 2026-11-05 (second-opinions 113): build error + clamp; it did crash (as the bundle loads).** **`marginTop: -8` (any negative margin) compiles, then very likely crashes the screen.** Compose's `PaddingValues` refuses negative values [checked path: [ZnTemplate.kt:519](../android/runtime/src/main/java/dev/zeronative/runtime/ZnTemplate.kt:519), no clamp in `edges()` :629, no build check; the crash itself not run]. No current code uses it | Build error now, with the hint "use transform: translateY". A real negative margin later (custom layout) | compiler | S | No (not used yet) |
| 0.3 | **Done 2026-11-05 (second-opinions 114).** **`effect(() => { ...; return () => stop() })` never calls the returned cleanup** [checked: [signals.ts:117](../packages/core/src/signals.ts:117) keeps it as the value]. RN's `useEffect` habit, so intervals and listeners leak | If `fn` returns a function, register it with `onCleanup` | JS core | S | No |
| 0.4 | **Done 2026-11-05 (second-opinions 115).** `position: "absolute"` (and `zIndex`) on a child of Column / Row / Box is laid out in the flow, silently | Build error "absolute needs a Stack parent" now; maybe real support later (L) | compiler | S | No |
| 0.5 | **Done 2026-11-08 (registry 23; second-opinions 163): top-level `<Text onPress>` and `<Text onLongPress>` supported directly with Role.Button semantics, no ripple/opacity change.** Non-Pressable/Text taps still give build error with "wrap it in Pressable". | compiler + runtime | S | No |
| 0.6 | **Done 2026-11-08 (registry 23; second-opinions 164): `<List horizontal>` and `<FlatList horizontal>` supported natively via Compose `LazyRow`.** Inverted, sticky headers, and pull-to-refresh fail sideways with clear build errors. | compiler + runtime | S | No |
| 0.7 | **Done 2026-11-05 (second-opinions 115), and 1.5 is built too.** `renderItem={({ item }) => ...}` copied into `row` compiles, but `item` is undefined (row gets the raw item) | Covered by alias 1.5 below; until then a build error on a destructured `row` param | compiler | S | No |
| 0.8 | **Done 2026-11-05 (second-opinions 116): a table generated from the UI types, `bun run gen:tag-props`.** Any registry prop on any tag is accepted (`<Image horizontal>`, `<Text value>`): no effect, no error | Check props per tag in the compiler | compiler | M | No |
| 0.9 | **Done 2026-11-05 (second-opinions 115).** `transform: [{ scale: 2 }, { translateX: 10 }]`: order is lost (zn moves 10, RN moves 20) | Build error when the order would matter | compiler | S | No |

More silent differences, documented rather than fixed (the guide should say them): timers die with their screen;
`useWindowDimensions()` read into a variable is a snapshot; `Dimensions.get()` at file top returns 0 with no warning;
`storage.get` gives `undefined`, not `null`; `Linking` only sees links of `deepLink` routes; `AppState` has no
`inactive`; `requestAnimationFrame` is a 16 ms timer; `fetch` has a 30 s default timeout and a 10 MB cap; a List
`row`'s `index` is the index at mount; `onEndReached` fires 5 rows before the end, not by screen length; a
Pressable ripples by default (RN doesn't); a Row stretches children only with a fixed height.

## P1. Cheap RN names, compiler only (no new APK), used a lot

| # | RN code | Becomes | Cost |
|---|---|---|---|
| 1.1 | **Done 2026-11-05 (second-opinions 117); `borderLeftWidth` / `borderRightWidth` left out (zn has no per-side border width).** `marginLeft`, `paddingRight`, `left`, `right`, `borderLeftWidth` | the `Start` / `End` keys | S |
| 1.2 | **Done 2026-11-05.** `textAlign: "left" / "right" / "auto"` | start / end / start (`justify`: error) | S |
| 1.3 | **Done 2026-11-05 (second-opinions 119): the 148 CSS names.** Named colours (`"white"`, `"red"`), `hsl()` | parseColor table (JS core, shared with compiler) | S |
| 1.4 | **Done 2026-11-05.** `<Image source={{ uri }} resizeMode="stretch">` | `src`, `contentScale` (`stretch` → fill) | S |
| 1.5 | **Done 2026-11-05 (second-opinions 115).** `<FlatList keyExtractor renderItem={({ item, index }) => ...}>` | `List key row`, param rewritten; default key `item.key ?? item.id` | S–M |
| 1.6 | **Done 2026-11-05 (second-opinions 117).** `flexGrow: 1`; `flexShrink: 0/1`, `flexBasis: 0/"auto"` | `flex: 1`; the others dropped (they match zn) | S |
| 1.7 | **Done 2026-11-05.** ScrollView / FlatList perf and iOS props (`showsVerticalScrollIndicator`, `initialNumToRender`, `extraData`, `keyboardShouldPersistTaps="handled"`, ...) | accepted and dropped, like the Modal iOS props | S |
| 1.8 | **Done 2026-11-05 (second-opinions 117).** `TouchableOpacity activeOpacity`, `TouchableHighlight underlayColor`, `TouchableWithoutFeedback` | Pressable with no ripple + `pressOpacity` / `highlightColor` | S |
| 1.9 | **Done 2026-11-05.** `TextInput placeholderTextColor`, `keyboardType="numeric"`, `allowFontScaling={false}`, `ellipsizeMode="tail"` | `placeholderColor`, decimal-pad, `maxFontScale={1}`, dropped | S |
| 1.10 | **Done 2026-11-05.** `Switch trackColor={{ false, true }}`, `android_ripple={{ color, borderless, radius }}`, `ActivityIndicator size="large" animating` | the flat zn props | S |
| 1.11 | **Done 2026-11-05; `importantForAccessibility="no"` is a build error.** `aria-label`, `role`, `importantForAccessibility="no-hide-descendants"` | the `accessibility*` props | S |
| 1.12 | **Done 2026-11-05.** `StyleSheet.hairlineWidth`, `StyleSheet.flatten`, `rowGap` / `columnGap`, `width: "auto"`, `aspectRatio: "16/9"` | folded at build time | S |
| 1.13 | **Done 2026-11-05 for `View` only. `SafeAreaView` / `KeyboardAvoidingView` stay build errors (Pavan, 2026-11-05).** `<View style={{ flexDirection: "row" }}>`, `<SafeAreaView>`, `<KeyboardAvoidingView>` | Row / Column (from a static `flexDirection`); safe area and keyboard are route options already | M |

## P1. Cheap RN names, JS core (no new APK)

| # | RN code | Becomes | Cost | Watch out |
|---|---|---|---|---|
| 1.14 | **Done 2026-11-05 (second-opinions 118); no `useMemo`.** `useFocusEffect`, `useCallback(fn) = fn`, `useRef(init)` | `useFocus`; identity; `{ current }` | S | Don't add `useMemo`: it would go stale silently |
| 1.15 | **Done 2026-11-05 (second-opinions 118); no `navigate`.** `useNavigation()` → `goBack`, `canGoBack`, `useRoute().params` | `nav.back`, `depth() > 1`, the screen's params | S | Leave out `navigate`: in React Navigation it jumps back to an existing screen, `push` doesn't |
| 1.16 | **Done 2026-11-05 (second-opinions 118).** `AsyncStorage` (Promise, strings, `null` for missing, `multiGet`) | its own store over `storage` | S | Keep it apart from `storage` (typed values) |
| 1.17 | **Done 2026-11-05 for `BackHandler`, `Appearance`, `useColorScheme`, `setImmediate` (second-opinions 118). `Easing.out`, MMKV and SecureStore names: not built (no zn API under them yet).** `BackHandler.addEventListener(...).remove()`, `Appearance`, `useColorScheme`, `Easing.out(...)`, `setImmediate`, MMKV / expo SecureStore names | thin wrappers | S each | Handlers stay per screen; `useColorScheme()` read into a variable is a snapshot |

## P2. Worth it, more work

| # | What | Lands | Cost |
|---|---|---|---|
| 2.1 | `ListHeaderComponent` / `ListFooterComponent` / `ListEmptyComponent` (ZeroBill's R5): the compiler adds them as row kinds | compiler | M |
| 2.2 | `ItemSeparatorComponent`: a plain spacer → `gap`; a drawn line → native separator | compiler; native for lines | S / M–L |
| 2.3 | `style={[s.a, active() && s.b]}` (conditional style entries): per-key slots | compiler | M |
| 2.4 | `Pressable style={({ pressed }) => ...}` when it changes only opacity, scale or background | compiler | M |
| 2.5 | `SectionList` → List with header rows and sticky indices | compiler | M |
| 2.6 | `flexWrap: "wrap"` (chips) → FlowRow; per-side border colours and left/right widths | registry + runtime | M |
| 2.7 | `zIndex` on Row / Column children; `alignSelf: "stretch"` in a centred Column | runtime | S |
| 2.8 | `XMLHttpRequest` over fetch (axios); `crypto.getRandomValues` (native secure random, never `Math.random`) | JS core; host API | M |
| 2.9 | `I18nManager.isRTL`, `AccessibilityInfo`, `InteractionManager` | JS + small native | S–M |

## Not now (real features, keep as build errors)
`Animated` (L: a same-name API that works only for fades would mislead), `onScroll`, `scrollTo`, `numColumns`,
`inverted`, `pagingEnabled`, `selectable`, `WebSocket`, custom fonts, React `createContext` / `Provider`, real
negative margins, absolute children outside a Stack.

## Proposed order
1. **P0.1 to P0.3 now** (2 runtime S, 1 compiler S, 1 JS S): 0.1 fixes the pilot's look today; 0.2 removes a crash.
2. **P0.4 to P0.7, P0.9** (build errors, all S): one compiler batch.
3. **P1** as one "RN names" compiler + JS batch, in its own session.
4. P2 one at a time, when an app needs it. 2.1 first (ZeroBill R5).
