# Coming from React Native

If you already know React Native, you'll feel right at home in `zero-native`. Most component names, style properties, and platform APIs (`View`, `Text`, `Pressable`, `FlatList`, `Modal`, `StatusBar`, `StyleSheet`, `Linking`, `Alert`, `AsyncStorage`, `fetch`, and `WebSocket` on Android) match React Native on purpose.

The difference is **what happens underneath**: there is no React reconciler, no virtual DOM, and no Yoga. Here are the four mental shifts to learn first, followed by a quick migration cheat sheet.

---

## The 4 Big Mental Shifts

### 1. Components run ONCE — they never re-render
In React, changing state re-runs your entire component function. In `zero-native`, your component function runs **once** on mount, and **signals** update only the exact leaf text or style slot that changed.

```tsx
// React Native
const [count, setCount] = useState(0)
const doubled = count * 2 // recalculated every render

// zero-native
const count = signal(0)
const doubled = computed(() => count() * 2) // reactive!
// Plain `const doubled = count() * 2` would stay frozen at 0!
```

### 2. No hooks rules — use `signal`, `computed`, `effect`
- No `useState`, `useMemo`, or dependency arrays (`[a, b]`).
- `computed()` and `effect()` track whichever signals they read automatically.
- Simple top-level prop destructuring (`function Card({ title })`) works and stays reactive, but rest (`...rest`), nested/array destructuring, and reassigning destructured params fail the build.
- Simple top-level early returns (`if (loading()) return <Spinner />`) work; early returns inside loops, `try`, or `switch` fail the build.

### 3. Native layout (Compose / SwiftUI), not Yoga
- Use `<Column>` (vertical), `<Row>` (horizontal), and `<Stack>` (overlays / `position: "absolute"`). `<View>` also works and compiles to `<Column>` (or `<Row>` if `flexDirection: "row"`).
- Style modifiers always apply in **one fixed order** (`margin → size → transform → shadow → background → border → clip → press feedback → padding`).
- Unsupported style keys, dynamic structural style keys (`alignItems`, `justifyContent`, `position`, `flexDirection`, `flexWrap`), and RN components without a direct alias (`ScrollView`, `TextInput`, `SafeAreaView`, `KeyboardAvoidingView`, `SectionList`, `ImageBackground`) are **loud build errors** with a hint — never silent no-ops.
- Safe areas are a route option (`safeArea: "all" | "none" | { top?: boolean; bottom?: boolean }`), not a `<SafeAreaView>` component.

### 4. No React npm ecosystem (and you don't need Reanimated or Worklets)
Libraries that depend on React's runtime (`react-navigation`, `react-native-reanimated`, `NativeWind`, React hook libraries) do not run here. Instead, `zero-native` includes typed navigation, UI-thread motion/gestures, compiled SVG, `OtpInput`, `Sheet`, `Carousel`, and 20 official plugins out of the box.

---

## Side-by-Side Cheat Sheet

### Components
| React Native | zero-native (`@zeronative/ui`) | Notes |
|---|---|---|
| `<View>` | `<View>`, `<Column>`, `<Row>`, `<Stack>` | Prefer `Column`/`Row`/`Stack` for clarity |
| `<Text>` | `<Text>` | Nested `<Text>` spans & `onPress` work |
| `<Pressable>` | `<Pressable>` | Adds `pressFeedback`, `pressScale`, `haptic`, `onPressRepeat` |
| `<TouchableOpacity>` / `Highlight` / `WithoutFeedback` | Same names | Built-in compiler aliases over `<Pressable>` |
| `<TextInput>` | `<TextField>` | `<TextInput>` is a build error with a hint to use `<TextField>` |
| `<ScrollView>` | `<Scroll>` | `<ScrollView>` is a build error with a hint to use `<Scroll>` |
| `<FlatList>` | `<List>` or `<FlatList>` | Both `row`/`key` and RN's `renderItem`/`keyExtractor` work |
| `<ActivityIndicator>` | `<Spinner>` or `<ActivityIndicator>` | Draw-phase native spinner |
| `<Switch>`, `<Modal>`, `<StatusBar>` | Same names | Built-in |
| `<Image source={{ uri }}>` | `<Image src="...">` or `source={{ uri }}` | `require(...)` → `src="asset:images/..."` |
| `react-native-svg` | `<Svg>`, `<Path>`, ... or `import Icon from "./icon.svg"` | Compiled at build time |
| `react-native-otp-entry` | `<OtpInput>` | Built-in |
| `@gorhom/bottom-sheet` | `<Sheet>` | Built-in native draggable sheet |

### APIs & State
| React Native | zero-native (`@zeronative/core`) | Notes |
|---|---|---|
| `useState` | `signal(initial)` | Read `s()`, write `s.set(next)` |
| `useMemo` | `computed(() => ...)` | Auto-tracked, no dependency array |
| `useEffect` | `effect(() => { ...; onCleanup(...) })` | Auto-tracked |
| `useRef` / `createRef` | `createRef()` / `useRef()` | Same |
| `React Navigation` | `defineRoutes` + `nav.push/replace/reset/back` | `useNavigation`, `useRoute`, `useFocusEffect` aliases exist |
| `AsyncStorage` | `storage` (sync MMKV) or `AsyncStorage` | `AsyncStorage` uses its own separate store |
| `expo-secure-store` | `SecureStore` | Keystore / Keychain with transient-error safety |
| `BackHandler` | `useBack(() => boolean)` or `BackHandler` | Return `true` to block pop |
| `Appearance` / `useColorScheme` | `colorScheme()` / `useColorScheme()` | Reactive signal |
| `Linking`, `Share`, `Alert`, `Keyboard`, `Clipboard`, `Vibration`, `Platform`, `Dimensions`, `PixelRatio` | Same names | Imported from `@zeronative/core` |
| `Reanimated` + `Gesture Handler` | `useMotion`, `derive()`, `usePan`, `usePinch`, `animate`, `sharedTag` | No worklets runtime needed (Android today; iOS in progress) |
| `CodePush` / `EAS Update` | Built-in `Updates` + `zn-updates` server | Contract-checked, ECDSA-signed, bsdiff patches (Android) |

---

## Common Porting Gotchas

1. **Imports come from `@zeronative/ui` and `@zeronative/core`**, not `"react-native"`.
2. **Don't pass `onPress` to `<View>` / `<Column>` / `<Row>`:** wrap in `<Pressable>`.
3. **Avoid `transform: [{ scaleY: -1 }]` for chat lists:** use `<List inverted>` instead (the compiler refuses flipped lists).
4. **Inline `<RefreshControl>`:** pass `refreshControl={<RefreshControl ... />}` directly inline (don't store it in a variable), or use the flat `refreshing` / `onRefresh` props.
5. **Conditional styles:** `[s.a, active() && s.b]` is a build error — use `{ color: active() ? "#000" : "#666" }`.
