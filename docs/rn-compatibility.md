# React Native compatibility map

How the React Native (RN) APIs and components an app commonly uses map to zero-native (`zn`). Use it to estimate
and plan a move from RN, and to find what to do for each piece.

**Checked on 2026-11-02** against the code, not only the docs. The sources are `packages/ui/src/index.ts` (components,
style keys), `packages/template/src/registry.ts` (what can really be set), `compiler/src/compile.ts` (what the build
accepts), `packages/core/src/index.ts` (what is exported), and the Android runtime. Line numbers match the working
tree that includes step P.2 (permissions, launches, `Os`, `detached`, `zn://app-icon`). Steps P.3 and after
(UPI, auth, scanner, native views, native screens, push, WebView, media) are **not built**: they show as `missing`.
**Updated 2026-11-03** for P.3b–P.6 (rows for dark mode, scanner, media, WebView, auth, native views, background tasks,
secure screens). Those rows link to files, not lines, and were not re-checked by a second reviewer. Push is still missing.

**Status words**
- **same**: same name and same meaning. Copy the code.
- **renamed**: same idea, different name or value. Change the name.
- **different**: the idea exists but works another way. Read the "how to move" line.
- **missing**: no equivalent today. The line says what to do instead, or what is planned.

## 0. Four big differences to know first

1. **Only a few values can change at runtime.** `color`, `backgroundColor`, `opacity`, transforms, image `src`,
   `disabled`, per-edge padding, `text`, `value`, `placeholder`, `editable`, `visible`, `accessibilityLabel`,
   `impressionKey`. Everything else (width, height, margin, flex, `fontSize`, `borderRadius`...) must be known at build
   time. A signal there is a **build error with file and line**. RN code like `style={{ width: w }}` with a changing
   `w` must become two styles chosen by a ternary, or an `animate` prop. This is the largest source of edits.
   [registry.ts:293](../packages/template/src/registry.ts:293), [compile.ts:638](../compiler/src/compile.ts:638).
2. **No React.** No hooks, no `useState`, no `useEffect`, no context, no `ref`, no `memo`. State is signals, and a
   component body runs once. See [guide-notes.md](guide-notes.md) §1–2.
3. **Unknown props and style keys fail the build.** Nothing is silently ignored.
   [compile.ts:264](../compiler/src/compile.ts:264), [compile.ts:676](../compiler/src/compile.ts:676).
4. **Android only today.** There is no `Platform.OS`. iOS (SwiftUI) comes later.

## 1. Components

| RN | zero-native | Status | How to move |
|---|---|---|---|
| `View` (column) | [`Column`](../packages/ui/src/index.ts:169) | renamed | `flexDirection` is not a style key: pick the component. `View` with default direction becomes `Column`. |
| `View` (`flexDirection: "row"`) | [`Row`](../packages/ui/src/index.ts:170) | renamed | Replace `flexDirection: "row"` with `<Row>`. `alignItems: "stretch"` in a Row needs a fixed height ([platform-differences.md](platform-differences.md)). |
| `View` (overlay, `position: "absolute"`) | [`Stack`](../packages/ui/src/index.ts:171) | different | Absolute children work only inside `Stack`. `zIndex` too. Use `start` / `end` instead of `left` / `right`. |
| `View` (plain box) | [`Box`](../packages/ui/src/index.ts:172) | renamed | Use for a decoration layer or one-child wrapper. |
| `Fragment` / `<>` | `<>...</>` ([compile.ts:225](../compiler/src/compile.ts:225)) | same | `<React.Fragment>` is rejected: write `<>`. |
| `Text` | [`Text`](../packages/ui/src/index.ts:173) | different | Text lives only in `Text`. Nested `<Text>` spans work. Missing props: `ellipsizeMode`, `selectable`, `adjustsFontSizeToFit`, `onPress`, `allowFontScaling` (use `maxFontScale`). Make a tappable text with `Pressable` around it. |
| `Image` (`source={{ uri }}`) | [`Image src`](../packages/ui/src/index.ts:175) | renamed | `source={{ uri: u }}` becomes `src={u}`. `require("./a.png")` becomes `src="asset:images/a.png"` (an `assets/` folder next to `src/`). |
| `Image resizeMode` | [`contentScale`](../packages/ui/src/index.ts:179) | renamed | `cover`, `contain` same. `stretch` becomes `fill`. `center`, `repeat` are missing. |
| `Image defaultSource` | [`fallbackSrc`](../packages/ui/src/index.ts:178) | different | `fallbackSrc` shows on **error**, not while loading. For a loading look use `loading="shimmer"`. |
| `Image onLoad` / `onError` / `tintColor` / `blurRadius` / `Image.getSize` | none | missing | No events or tint. A single-colour image: use `Icon` (SVG path data, `color`). |
| `ImageBackground` | `Stack` + `Image` | missing | Put an `Image` and the content in a `Stack`. A gradient is `backgroundImage` on a style. |
| `Icon` (react-native-vector-icons, svg) | [`Icon`](../packages/ui/src/index.ts:183) | different | SVG path data in a `.ts` file, fill paths only. No icon font, no `react-native-svg`. |
| `ScrollView` | [`Scroll`](../packages/ui/src/index.ts:243) | different | Props: `horizontal` only. Missing: `onScroll`, `scrollTo` / refs, `contentContainerStyle` (padding on `Scroll` scrolls with the content), `refreshControl`, `showsVerticalScrollIndicator`, `keyboardShouldPersistTaps`. Long vertical data must use `List`. |
| `FlatList` | [`List`](../packages/ui/src/index.ts:343) | different | `data` same. `keyExtractor` → the `key` prop. `renderItem` → `row`. `ItemSeparatorComponent` → `gap`. `onEndReached` same. [lists.md](lists.md). |
| `FlatList` headers, empty, footer | row kinds in `row` | different | Put a header or footer item in `data` and choose its row with `cond ? <A/> : <B/>`. |
| `FlatList` `numColumns`, `horizontal`, `inverted`, `onRefresh`, `scrollToIndex`, `getItemLayout`, `ListEmptyComponent` | none | missing | Horizontal: use `Scroll horizontal`. Grid, pull to refresh, `scrollToIndex`: no equivalent. Show the empty state with a `cond && <X/>` outside the list. |
| `SectionList` | none | missing | Flatten sections into one `data` array with header items. |
| `FlatList onViewableItemsChanged` | [`useImpressions`](../packages/core/src/nav.ts:143) + `impressionKey` | different | Counted natively once a card is visible enough. No scroll events in JS. |
| `.map()` in JSX | `{items.map(i => <Row key={i.id}/>)}` | same | Up to ~100 items. The `key` goes on the row's root. |
| `Pressable` | [`Pressable`](../packages/ui/src/index.ts:276) | different | `onPress`, `onPressIn`, `onLongPress`, `disabled` same. `onPressOut` gets `cancelled` (a boolean), not an event. Layout nodes take no `onPress`: only `Pressable`. |
| `Pressable style={({ pressed }) => ...}` | `pressFeedback`, `pressScale`, `pressOpacity`, `highlightColor` | different | The style function is not supported. Pick the effect by prop: native draws it with no JS. |
| `Pressable android_ripple` | `rippleColor`, `rippleBorderless`, `rippleRadius`, `rippleOpacity` | renamed | Move each field to its own prop. The ripple is on by default. |
| `TouchableOpacity` / `TouchableHighlight` | `Pressable pressOpacity` / `pressFeedback="highlight"` | renamed | `activeOpacity` → `pressOpacity`. `underlayColor` → `highlightColor`. |
| `Pressable hitSlop`, `delayLongPress`, `testID` | none | missing | Make the `Pressable` bigger with padding. No `testID` today. |
| `Button` | none | missing | Build it from `Pressable` + `Text`. |
| `TextInput` | [`TextField`](../packages/ui/src/index.ts:312) | renamed | See the prop rows below. |
| `TextInput` `value`, `onChangeText`, `placeholder`, `maxLength`, `multiline`, `autoFocus`, `editable`, `autoCorrect`, `selectionColor`, `onFocus`, `onBlur` | same names | same | Set `value` in `onChangeText` synchronously (the field always ends up showing `value`). |
| `TextInput placeholderTextColor` | `placeholderColor` | renamed | Rename. |
| `TextInput keyboardType` | `keyboardType` | different | Values: `default`, `number-pad`, `decimal-pad`, `phone-pad`, `email-address`, `url`. RN `numeric` → `number-pad` or `decimal-pad`. |
| `TextInput onSubmitEditing` | `onSubmitEditing(text)` | different | It gets the text, not an event. Key label: `returnKeyType` (`done`, `go`, `next`, `search`, `send`). |
| `TextInput` `secureTextEntry`, `autoCapitalize` | same names | same | `autoCapitalize`: `none`, `sentences`, `words`, `characters`. |
| `TextInput` `onChange`, `onKeyPress`, `onSelectionChange`, `selection`, `defaultValue`, `inputMode`, `autoComplete`, `textContentType`, `numberOfLines`, `ref.focus()` / `blur()` / `clear()` | none | missing | Use `value` as the initial value. Close the keyboard with `Keyboard.dismiss()`. No focus control or key events yet. |
| `ActivityIndicator` | [`Spinner`](../packages/ui/src/index.ts:213) | renamed | `size` is a number in dp (not `"small"` / `"large"`). `color` same. |
| `Switch` | [`Switch`](../packages/ui/src/index.ts:188) | different | `value`, `onValueChange`, `disabled`, `thumbColor` same. `trackColor={{ false, true }}` → `trackColor` (off) + `activeTrackColor` (on). It is strictly controlled: set the signal or the thumb does not move. |
| `Checkbox` (community) | [`Checkbox`](../packages/ui/src/index.ts:201) | different | `value`, `onValueChange`, `color`, `activeColor`. |
| (progress bar libs) | [`Progress`](../packages/ui/src/index.ts:222) | different | `value` 0–1, omit for endless. |
| (skeleton libs) | [`Shimmer`](../packages/ui/src/index.ts:232) | different | All shimmers on screen move in step. |
| `Modal` | [`Sheet`](../packages/ui/src/index.ts:250) or route `transition: "modal"` | different | `Sheet` is a controlled bottom sheet (`visible`, `onDismiss`). Centred dialogs / `Modal` `transparent` are missing. |
| `Alert.alert` | none | missing | Build a `Sheet` or an inline confirm. There is no native alert call. |
| `Dimensions`, `useWindowDimensions`, `PixelRatio` | none | missing | Use `flex` and `%` sizes. Safe-area numbers: [`insets()`](../packages/core/src/insets.ts:23). |
| `SafeAreaView` / `react-native-safe-area-context` | route option `safeArea` + [`insets()`](../packages/core/src/insets.ts:23) | different | Delete `SafeAreaView`. Set `safeArea` on the route ([routes.ts:20](../packages/core/src/routes.ts:20)); for a coloured header use `insets().top`. |
| `StatusBar` | route option `statusBar: "dark" \| "light"` | different | Per route, not per component. [routes.ts:22](../packages/core/src/routes.ts:22). |
| `KeyboardAvoidingView` | route option `keyboard: "resize"` | different | On by default. Delete the component. [routes.ts:29](../packages/core/src/routes.ts:29). |
| `RefreshControl` | none | missing | No pull to refresh. Use a visible refresh button, or wait for it to be built. |
| `Animated`, `LayoutAnimation`, `Easing` | `animate`, `enter`, `exit` props, [`Timing`](../packages/ui/src/index.ts:104) | different | No `Animated.Value`. Say how a change should animate: `animate={250}` or `animate={{ opacity: 200, translateY: "spring" }}`. `enter` / `exit` for mount and unmount. Gesture-driven animation is missing. |
| `Reanimated` | none | missing | Same as above. Only opacity, background colour, scale, translate, rotate can animate. |
| `StyleSheet.create` | [`StyleSheet.create`](../packages/ui/src/index.ts:353) | same | Folded at build time. `StyleSheet.flatten`, `hairlineWidth`, `absoluteFill` are missing. |
| `accessibilityLabel`, `accessibilityHint` | same names | same | [ui/index.ts:153](../packages/ui/src/index.ts:153). |
| `accessibilityRole` | same name | different | Values: `button`, `header`, `image`, `link`, `text`, `switch`, `checkbox`, `none`. Others are a build error. |
| `accessibilityElementsHidden` / `importantForAccessibility` | `accessibilityHidden` | renamed | One boolean. |
| `accessible`, `accessibilityState`, `accessibilityActions`, `testID`, `onLayout`, `pointerEvents`, `ref` | none | missing | No equivalent. Remove them. `accessibilityState` for toggles: use `Switch` / `Checkbox`. |

## 2. Style keys

Types: [`StyleProps`](../packages/ui/src/index.ts:31), [`TextStyleProps`](../packages/ui/src/index.ts:86). The real list
is the `Prop` table in [registry.ts:59](../packages/template/src/registry.ts:59). Remember: most values must be
known at build time (section 0).

| RN key | zero-native | Status | How to move |
|---|---|---|---|
| `flex`, `width`, `height`, `minWidth`, `maxWidth`, `minHeight`, `maxHeight`, `aspectRatio`, `gap`, `justifyContent`, `alignItems`, `alignSelf` | same | same | `width` / `height` take a number or `"N%"`. `alignItems` has no `baseline`. `justifyContent` has all six values. |
| `margin*`, `padding*` (`Horizontal`, `Vertical`, `Top`, `Bottom`) | same | same | Negative margins are a build error: use `transform: translate`. |
| `marginLeft`, `marginRight`, `paddingLeft`, `paddingRight` | `marginStart`, `marginEnd`, `paddingStart`, `paddingEnd` | renamed | `Left` → `Start`, `Right` → `End` (these also flip for right-to-left). |
| `left`, `right`, `top`, `bottom` | `start`, `end`, `top`, `bottom` | renamed | `position: "absolute"` only for children of `Stack`. `position: "relative"` with offsets is a build error. |
| `flexDirection` | `Row` / `Column` | different | Build error with a hint. |
| `flexWrap`, `flexGrow`, `flexShrink`, `flexBasis`, `alignContent`, `rowGap`, `columnGap`, `display` | none | missing | Wrap: no replacement yet. `flexGrow` → `flex`. `display: "none"` → `cond && <X/>`. |
| `backgroundColor`, `opacity`, `elevation`, `shadowColor` | same | same | `backgroundColor` and `opacity` can change at runtime. |
| `borderRadius`, `borderWidth`, `borderColor` | same | different | One radius for all corners only. |
| `borderTopWidth`, `borderBottomWidth` | same | same | Both use the one `borderColor`. |
| `borderTopLeftRadius` and the other corner keys, `borderLeftWidth`, `borderRightWidth`, `borderStyle`, per-side colours | none | missing | Nest a `Box`, or draw a divider as a thin `Box`. |
| `shadowOffset`, `shadowOpacity`, `shadowRadius` | none | missing | Use `elevation` and `shadowColor`. |
| `overflow` | same | different | `visible` or `hidden` only (`scroll` is missing). |
| `zIndex` | same | different | Only inside `Stack`. |
| `transform` | same | different | `scale`, `scaleX`, `scaleY`, `translateX`, `translateY`, `rotate` (`"45deg"` or a number). No `skew`, `perspective`, `matrix`. |
| `backgroundImage: "linear-gradient(...)"` | same | same | Build-time only. Not for radial gradients. |
| `color`, `fontSize`, `fontStyle`, `letterSpacing`, `lineHeight`, `textDecorationLine`, `numberOfLines` | same | same | `numberOfLines` is both a prop and a style key. |
| `fontWeight` | same | different | Numbers 100–900 in steps of 100, `"normal"`, `"bold"`. `"500"` as a string is a build error. |
| `textAlign` | same | renamed | `left` → `start`, `right` → `end`, `center` same. `justify` is missing. |
| `maxFontScale` | same | different | New key (RN has `maxFontSizeMultiplier`). |
| `fontFamily`, `textTransform`, `textAlignVertical`, `includeFontPadding`, `textShadow*`, `userSelect` | none | missing | Only the system font. Change case in the string yourself. Custom fonts are not built. |
| `tintColor`, `resizeMode` (as a style) | none / `contentScale` prop | missing | See Image. |

## 3. Navigation

zero-native has its own small navigator: a stack of screens, native transitions, back handling. It is not
React Navigation. [nav.ts:73](../packages/core/src/nav.ts:73), [routes.ts](../packages/core/src/routes.ts).

| RN (React Navigation) | zero-native | Status | How to move |
|---|---|---|---|
| `createNativeStackNavigator` + `Stack.Screen` | [`defineRoutes`](../packages/core/src/routes.ts:65) + [`startApp`](../packages/core/src/nav.ts:254) | different | One `routes.ts`: `name: { path, screen, ...options }`. The route order is the number used at runtime. |
| `navigation.navigate(name, params)` / `push` | [`nav.push`](../packages/core/src/nav.ts:75) | renamed | Names and params are type-checked (register the routes type). Params must be plain JSON: pass ids, not objects. |
| `navigation.goBack()` | [`nav.back`](../packages/core/src/nav.ts:82) | renamed | Returns `false` on the last screen. |
| `navigation.replace` | [`nav.replace`](../packages/core/src/nav.ts:89) | same | |
| `navigation.reset` | [`nav.reset`](../packages/core/src/nav.ts:96) | same | Takes `[{ name, params }]`, bottom first. |
| `route.params` | screen props | different | Params arrive as the props of the screen function. Every `:param` in the path must be a string prop. |
| `navigation.getState()` / `useRoute` | [`nav.current()`](../packages/core/src/nav.ts:108), [`nav.depth()`](../packages/core/src/nav.ts:114) | different | |
| `BackHandler.addEventListener("hardwareBackPress")` | [`useBack`](../packages/core/src/nav.ts:124) | renamed | Return `true` when you handled it. Call it in the screen body, only the top screen is asked. |
| `beforeRemove` listener | `useBack` | different | Covers the system back only. Make the on-screen back button call the same handler. |
| Screen options: `animation`, `presentation: "modal"` | route `transition: "push" \| "modal" \| "fade" \| "none"` | renamed | [routes.ts:18](../packages/core/src/routes.ts:18). |
| Deep link `linking` config | route `deepLink: true` + [`onLink`](../packages/core/src/nav.ts:244) + the app manifest | different | Opt-in per route. Match by path (`zn://<app>/<path>` or the scheme in your `AndroidManifest.xml`). Query values become params. `onLink` can refuse a link. [ZnNav.kt:343](../android/runtime/src/main/java/dev/zeronative/runtime/ZnNav.kt:343). |
| Restore state after the app was killed | route `restore` + [`restorableSignal`](../packages/core/src/nav.ts:162) | different | The stack comes back by itself. Small values you want back: `restorableSignal` (≤ 4,000 chars of JSON). |
| `useFocusEffect`, `useIsFocused`, `navigation.addListener("focus")` | none | missing | No focus events. Use `onAppState` for the app, and run code in the screen body once. |
| `navigation.setOptions` / header bar (`headerShown`, `headerRight`, `headerTitle`) | none | missing | There is no header component. Build the header in your screen (a `Row`). |
| Tab navigator (`createBottomTabNavigator`), drawer, top tabs | none | missing | No tab bar or drawer. Build tabs with a `Pressable` row and a `cond && <X/>` content area, or a `Carousel`. |
| Nested navigators, `navigation.setParams`, `navigation.getParent()` | none | missing | One flat stack. Put state in signals or `restorableSignal`. |
| Await a result from a screen (`navigation.navigate` with a callback / event) | none (`nav.pushForResult` is planned P.4a) | missing | Pass the result through a shared signal or `flowStore` until it is built ([plugins.md](plugins.md) §5). |

## 4. Storage

| RN | zero-native | Status | How to move |
|---|---|---|---|
| `AsyncStorage.getItem` / `setItem` / `removeItem` | [`storage.get*`](../packages/core/src/storage.ts:33) / `set` / `delete` | different | **Synchronous**, no `await`. Typed: `getString`, `getNumber`, `getBoolean`, `getBytes`. `getAllKeys` → `keys()`, `clear` → `clear()`. `multiGet` / `multiSet` / `mergeItem` are missing: loop. |
| `react-native-mmkv` (`new MMKV({ id })`) | [`createStorage(id)`](../packages/core/src/storage.ts:163), [`storage`](../packages/core/src/storage.ts:171) | renamed | Same engine and shape (MMKV). `getString`, `getNumber`, `getBoolean`, `set`, `delete`, `clearAll` → `clear`. `onChange` → `onChange`. |
| `redux-persist`, a persisted store | [`persistedSignal`](../packages/core/src/storage.ts:178) | different | A signal that saves itself as JSON. |
| `expo-secure-store` / `react-native-keychain` | [`SecureStore`](../packages/core/src/secure-store.ts:108) | different | `get` / `set` / `delete`, strings only (≤ 64 KB), async, Android Keystore. `get` returns `null` if the value can no longer be read: treat as "sign in again". No biometric prompt option. |
| (no RN equivalent) crash-safe record | [`flowStore`](../packages/core/src/flowstore.ts:18) | different | Not in RN. Use it for a payment record that must never be lost. [guide-notes.md](guide-notes.md) §16. |
| `react-native-fs`, `expo-file-system` | none | missing | No file API in core. Planned in the `media` plugin (P.6). |

## 5. Network and web APIs

| RN | zero-native | Status | How to move |
|---|---|---|---|
| `fetch` | [`fetch`](../packages/core/src/fetch.ts:368) | same | OkHttp underneath. HTTP errors do not throw: check `res.ok`. Network failures throw [`FetchError`](../packages/core/src/fetch.ts:87) with a `code` (`offline`, `dns`, ...). |
| Differences from RN `fetch` | [fetch.md](fetch.md) | different | Default timeout 30 s, response limit 10 MB ([`setFetchDefaults`](../packages/core/src/fetch.ts:43)). No `res.body` stream. `credentials`, `cache`, `mode` are accepted and ignored. A fetch is not cancelled when its screen closes: use [`useAbortSignal()`](../packages/core/src/abort.ts:114) for that. |
| `Headers`, `Request`, `Response`, `FormData`, `URLSearchParams`, `AbortController` | [`Headers`](../packages/core/src/headers.ts:32), [`Request`](../packages/core/src/fetch.ts:128), [`Response`](../packages/core/src/fetch.ts:182), [`FormData`](../packages/core/src/formdata.ts:39), `AbortController` | same | A file in `FormData` is `{ uri, name, type }` with a `content://` or `file://` uri, as in RN. |
| `XMLHttpRequest`, axios (XHR adapter) | none | missing | Use `fetch`. For axios, use its `fetch` adapter or replace it. Upload progress is missing. |
| `WebSocket` | none | missing | Not built and not planned yet. |
| `NetInfo` | none | missing | Handle `FetchError` code `offline`. |
| `URL`, `atob`, `btoa`, `crypto.getRandomValues`, `structuredClone` | not in core | missing | [check] Hermes may give some of them. Not provided or tested by core. |
| `setTimeout`, `setInterval` | [timers.ts:57](../packages/core/src/timers.ts:57) | different | Timers made in a screen **stop when the screen closes**. For work that must go on, use [`detached`](../packages/core/src/signals.ts:278). `setImmediate`, `requestAnimationFrame`, `InteractionManager` are missing. |
| `TextEncoder` / `TextDecoder`, `Intl` | installed by the runtime ([text.ts:78](../packages/core/src/text.ts:78)) | same | |
| `console.log` | installed by the runtime | same | |
| `ErrorUtils.setGlobalHandler` | [`onError`](../packages/core/src/errors.ts:37) | renamed | Also sees unhandled promise rejections. |

## 6. Device and OS

| RN | zero-native | Status | How to move |
|---|---|---|---|
| `Linking.openURL(url)` | [`Os.openUrl`](../packages/core/src/os.ts:35) | renamed | Only `http`, `https`, `mailto`, `tel`. Anything else (`upi:`, `intent:`, `whatsapp:`) rejects with `not_allowed`: this is on purpose, so an OTA bundle can't open any app. [ZnOs.kt:14](../android/runtime/src/main/java/dev/zeronative/runtime/ZnOs.kt:14). Other schemes go through a plugin in Kotlin. |
| `Linking.canOpenURL` | none | missing | Call `openUrl` and handle `no_app`. |
| `Linking.openSettings()` | [`Os.openSettings`](../packages/core/src/os.ts:29) | renamed | |
| `Linking.getInitialURL()` / `addEventListener("url")` | [`startApp({ onLink })`](../packages/core/src/nav.ts:254) | different | The link opens its route by itself; `onLink(link)` can refuse it. `link.atStart` tells a cold start. The raw URL is `link.url`. |
| `Linking.sendIntent` | none | missing | Only Kotlin opens another app ([§7](#7-opening-another-app-for-a-result)). |
| `PermissionsAndroid.request` / `requestMultiple` | [`Permissions.request`](../packages/core/src/permissions.ts:20) | renamed | Takes a list of names: `"camera"`, `"contacts"`, `"location"`, `"microphone"`, `"notifications"`, or a full `android.permission.X`. Returns `granted`, `denied`, `blocked` (RN: `never_ask_again`). The permission must be in the manifest or the call fails with `not_declared`. |
| `PermissionsAndroid.check` | [`Permissions.status`](../packages/core/src/permissions.ts:23) | renamed | A permission never asked for reads as `denied`. |
| `AppState.currentState` | [`appState()`](../packages/core/src/app-state.ts:23) | renamed | Two states: `active`, `background` (no `inactive`). It reads a signal, so JSX follows it. |
| `AppState.addEventListener("change")` | [`onAppState`](../packages/core/src/app-state.ts:31) | renamed | Returns the stop function (RN: `.remove()`). Not called for the state at start. `background` also shows while a permission dialog or a see-through payment window is on top. |
| `Share.share({ message })` | [`Os.share`](../packages/core/src/os.ts:32) | different | Plain text only: `{ text }`. No `url`, `title`, files, or result (it returns whether the sheet opened). |
| `Vibration.vibrate`, `expo-haptics` | [`Os.haptic`](../packages/core/src/os.ts:26) | different | Four kinds: `light`, `medium`, `success`, `error`. No patterns or durations. On a `Pressable`, `haptic` gives a tick on press. |
| `Clipboard` | none | missing | Not built. |
| `DeviceInfo`, `Platform.Version`, `expo-application` | [`Os.info`](../packages/core/src/os.ts:23) | renamed | `appVersion`, `appBuild`, `android`, `sdk`, `model`, `manufacturer`. |
| `Platform.OS`, `Platform.select` | none | missing | Android only now. Remove the checks. |
| `Appearance`, `useColorScheme` | [`colorScheme`](../packages/core/src/appearance.ts), `scheme(light, dark)` | renamed | `colorScheme()` is a signal: `"light"` or `"dark"`. Templates draw before JS, so a dark phone can flash light colours at cold start ([guide-notes.md](guide-notes.md) §37). |
| `AppState` `memoryWarning` | [`onLowMemory`](../packages/core/src/appearance.ts) | renamed | Coil's memory cache is cleared for you. |
| `I18nManager.isRTL` | `(await Os.info()).rtl` | renamed | `start` / `end` style keys follow it. The app's manifest needs `supportsRtl`. |
| `react-native-screenshot-prevent`, `FLAG_SECURE` by hand | route option `secure: true` | different | Blocks screenshots while that route is on top. |
| `AppRegistry.registerHeadlessTask` | [`defineTask`](../packages/core/src/tasks.ts) | renamed | Called at the top of `main.ts`. A Kotlin plugin starts it with `ZnBackground.run`; it gets a time limit and an `AbortSignal`. Nothing in the framework starts one yet (push comes later). |
| `Keyboard.dismiss()` | [`Keyboard.dismiss`](../packages/core/src/keyboard.ts:89) | different | Returns a Promise. `Keyboard.addListener` is missing: the route option `keyboard: "resize"` handles the layout. |
| `Toast` (`ToastAndroid.show`) | [`toast`](../packages/core/src/toast.ts:72) | renamed | `toast("Saved", { duration: "short" })`. Survives navigation. |
| Self-update (CodePush, `expo-updates`) | [`Updates`](../packages/core/src/updates.ts:76) | different | Signed OTA bundles. See [ota.md](ota.md). |
| Camera / QR scan (`react-native-vision-camera`, `expo-camera`) | [`@zero-native/scanner`](../plugins/scanner/README.md) | different | QR and barcodes only, no photo or video. A full screen (route `native: "scanner.full"` + `nav.pushForResult`) or a view (`<QrScanner>`). ML Kit is bundled. |
| Image / file picker, PDF | [`@zero-native/media`](../plugins/media/README.md) | different | `Media.pickPhotos`, `pickFile`, `takePhoto`, `edit`. Files come back as `zn://file` handles plus a `file://` uri for upload. Results survive a kill (`Media.onResult`). |
| Push notifications (`@react-native-firebase/messaging`, `expo-notifications`) | none | missing | Later (Firebase work moved out). Background tasks, which it needs, are built. |
| `WebView` (`react-native-webview`) | [`@zero-native/webview`](../plugins/webview/README.md) | different | `<WebView>` with `allowedHosts`, `postMessage` both ways, links that leave the app, cookies, file upload. Debugging is opt-in (`WebViewPlugin(inspect = true)`). |
| Phone number hint, SMS auto-read | [`@zero-native/auth`](../plugins/auth/README.md) | different | `Auth.phoneHint`, `Auth.listenForOtp`. Every Play services failure gives a reason, never a crash: show "type it by hand". |
| UPI app list and launch | none | missing | Not in the framework: the app owns this plugin (`plugins.md` D7). `ZnLaunch` and `launches` do the hard part. The icon part is built: `<Image src="zn://app-icon/<package>" />` ([ZnHandles.kt:24](../android/runtime/src/main/java/dev/zeronative/runtime/ZnHandles.kt:24)). |
| Biometrics, location, contacts, maps, video | none | missing | Not planned yet. `Permissions.request` can ask for the permission, but no API uses it. |

## 7. Opening another app for a result

| RN | zero-native | Status | How to move |
|---|---|---|---|
| `startActivityForResult` in a custom module, `ActivityEventListener.onActivityResult` | [`ZnLaunch.start`](../android/runtime/src/main/java/dev/zeronative/runtime/ZnLaunch.kt:107) in Kotlin + [`launches`](../packages/core/src/launches.ts:77) in JS | different | The plugin (Kotlin) builds the Intent and starts it. JS gets the result through `launches.onResult(key, handler)`. |
| Result lost if the app is killed while the other app is open | `launches.pending(key)`, `launches.ack(key, id)` | different | The result is saved on disk **before** JS hears it, and comes again at every start until you call `ack`. Write your handler so it is safe to run twice. [guide-notes.md](guide-notes.md) §31. |
| Start an activity from JS with any Intent | none (on purpose) | missing | JS can't open any app with any data. Only a plugin's Kotlin can. |
| Native screen that returns a value | none (planned P.4a: `nav.pushForResult`) | missing | |
| Tell that the user came back, with no result | [`onAppState`](../packages/core/src/app-state.ts:31) | different | Act on `"active"`, then ask your server. |

## 8. Native modules and plugins

| RN | zero-native | Status | How to move |
|---|---|---|---|
| `NativeModules.X` / TurboModule spec | [`nativeModule<T>("X", { version })`](../packages/core/src/calls.ts:213) | different | Declare a TS interface. Methods take **one args object** and return a Promise. No sync methods. When the screen closes, its calls are dropped quietly unless you pass `owned: false` ([`CallOptions`](../packages/core/src/calls.ts:36)). |
| Native method with `Promise` | `ZnModuleBase` + `function("name") { call -> call.resolve(...) }` | different | Kotlin only. Read args with `call.string("x")`, `call.int("n")`; a wrong type rejects with `invalid_args`. [native-modules.md](native-modules.md). |
| `NativeEventEmitter` / `DeviceEventEmitter` | `handle.on("event", fn)` / [`onNativeEvent`](../packages/core/src/calls.ts:158) | renamed | Declare events in the interface (`events: { tick: number }`). |
| Module available on old app builds | module `version` in `nativeModule(...)` | different | An app whose APK has an older native module **ignores the bundle** (a safety rule for OTA). Raise the version when TS needs new native code. |
| Native binary data (base64 strings) | `BytesResult` ([calls.ts:49](../packages/core/src/calls.ts:49)) | different | Bytes cross as `ArrayBuffer`, not base64. |
| Autolinking (`react-native.config.js`, CLI) | `ZnPlugins.register(this, MyPlugin())` in `Application.onCreate` | different | By hand today: Gradle dependency + one line. Autolinking is decided for later (D1). [plugins.md](plugins.md) §8. |
| A library package with `android/` + `src/` | plugin package (`plugins/device-test` is the sample) | renamed | [`ZnPlugin`](../android/runtime/src/main/java/dev/zeronative/runtime/ZnPlugins.kt:10) registers modules. Guide: [guide-notes.md](guide-notes.md) §30. |
| `requireNativeComponent` / Fabric native view | `<NativeView name="plugin.view">` + `r.view(...)` in Kotlin | different | A Compose composable. Props are one JSON value; events come as `{ name, data }`. The name must be a literal, and its plugin's `nativeModule` must be in the bundle. |
| Native screen (a native Activity opened for a result) | route `native: "plugin.screen"` + `r.screen(...)` | different | Joins the normal back stack. `nav.pushForResult` gives the answer, `onNavResult` after a kill. |
| Codegen (TS spec → Kotlin / Swift) | none | missing | You write the Kotlin by hand. Planned only when needed (D2). |
| JS-only npm libraries | allowed if they use no React and no RN modules | different | A plugin that is plain TS can import `@zero-native/core` / `ui`. Anything using React hooks, `View` or `Platform` must be rewritten. |

## 9. React and JS-side patterns

| RN / React | zero-native | Status | How to move |
|---|---|---|---|
| `useState` | [`signal`](../packages/core/src/signals.ts:189) | renamed | `const [a, setA] = useState(0)` → `const a = signal(0)`; read `a()`, write `a.set(1)`. |
| `useMemo` | [`computed`](../packages/core/src/signals.ts:208) | renamed | |
| `useEffect` | [`effect`](../packages/core/src/signals.ts:219), [`onCleanup`](../packages/core/src/signals.ts:249) | different | Runs when the signals it read change. No dependency array. A component body runs once. |
| `useRef`, `forwardRef`, `useImperativeHandle` | none | missing | No refs. Use a signal, or a native module call. |
| `useContext` | module-level signals / imports | missing | No context. Share state through a module. |
| `useReducer`, Redux, Zustand | signals + plain modules | different | Stores that need React hooks do not work. A plain store (Zustand `vanilla`) can be wrapped in a signal. |
| `useCallback`, `React.memo` | not needed | missing | Delete them. |
| `useWindowDimensions` | none | missing | See §1. |
| `useColorScheme` | `colorScheme()` | renamed | See §6. |
| Conditional render `cond && <X/>`, `cond ? <A/> : <B/>` | same | same | [compile.ts:324](../compiler/src/compile.ts:324). A branch must be JSX or `null`. |
| Component props, `children` | same | different | `{props.children}` shows them; reading, mapping or counting children is not supported. Spread props `{...p}` are a build error. |
| Custom hooks | plain functions | different | A function that makes signals in a screen body works. |
| `Intl.NumberFormat` etc. | same | same | [guide-notes.md](guide-notes.md) §25. |

## 10. The ten items that would cost a migration the most

Ordered by the work they usually cause. "Missing" and "different" items only.

1. **Runtime changes to layout values** (different). `width`, `height`, `margin`, `flex`, `fontSize`, `borderRadius`
   must be known at build time. Any RN screen that sets these from state needs a redesign: two styles and a ternary,
   or an `animate` prop. Touches almost every non-trivial screen. ([§0](#0-four-big-differences-to-know-first))
2. **No React** (missing). Every `useState`, `useEffect`, `useRef`, `useContext`, `useMemo`, and every hook-based
   library (React Query, Formik, React Hook Form, most state libraries) must be replaced. This is a rewrite of screen
   logic, not an edit. ([§9](#9-react-and-js-side-patterns))
3. **Navigation: no tabs, no header bar, no nested navigators, no focus events** (missing). Most RN apps use a tab or
   drawer navigator and `headerRight`. All of it must be built by hand in your screens. ([§3](#3-navigation))
4. **`ScrollView` / `FlatList` features** (different / missing). No `onScroll`, no `scrollTo`, no refs, no pull to
   refresh (`RefreshControl`), no `SectionList`, no `numColumns`, no list header / footer / empty components (use row
   kinds). Apps that animate on scroll or have grids need a new design. ([§1](#1-components))
5. **`TextInput` control** (missing). No `ref.focus()` / `blur()`, no `onKeyPress`, no selection API, no
   `autoComplete`. OTP boxes and "jump to next field" flows need new code. ([§1](#1-components))
6. **Third-party native libraries** (missing). Every RN native library (camera, maps, WebView, push, file system,
   biometrics, image picker) has no zero-native twin yet, except the official plugins built in P.3b–P.6: scanner, auth,
   WebView and media. Push, maps, biometrics and video are still missing. A native view or screen is now a plugin's
   `r.view` / `r.screen`.
   ([§6](#6-device-and-os), [§8](#8-native-modules-and-plugins))
7. **Other apps and results through JS** (different). In RN a module can start any Intent. Here only Kotlin plugins can,
   and results come back through `launches` with `ack`. Every `Linking.openURL("upi://...")` or `intent:` call must
   move into a plugin. ([§6](#6-device-and-os), [§7](#7-opening-another-app-for-a-result))
8. **Styling gaps** (missing). No `flexWrap`, `fontFamily` (custom fonts), `textTransform`, per-corner radius,
   per-side border colours, `shadowOffset` / `shadowRadius`, `Image` `tintColor`. Designs that use them need a
   workaround or a framework change. ([§2](#2-style-keys))
9. **Animation model** (different). `Animated.Value`, `Reanimated`, `LayoutAnimation` and gesture-driven motion do not
   exist. `animate` / `enter` / `exit` cover simple changes only. Drag-to-dismiss cards, parallax, and custom
   transitions need a native component. ([§1](#1-components))
10. **Small OS APIs and web globals** (missing). `Alert`, `Clipboard`, `Dimensions`, `Appearance` / dark mode, `Platform`,
    `NetInfo`, `WebSocket`, `XMLHttpRequest`, `URL`, `atob` / `btoa`, `requestAnimationFrame`. Each is small, but
    together they touch many files, and `Alert`, `Clipboard` and `Dimensions` are used in almost every RN app.
    ([§1](#1-components), [§5](#5-network-and-web-apis), [§6](#6-device-and-os))

Smaller known gaps not in the list: `testID` (no test hook for UI tests), `Image` `onLoad` / `onError`, `Button`,
`Modal` as a centred dialog, `Text` `onPress` and `selectable`, `StyleSheet.flatten`.
