# React Native compatibility map

How the React Native (RN) APIs and components an app commonly uses map to zero-native (`zn`). Use it to estimate
and plan a move from RN, and to find what to do for each piece.

**Checked on 2026-11-02** against the code, not only the docs. The sources are `packages/ui/src/index.ts` (components,
style keys), `packages/template/src/registry.ts` (what can really be set), `compiler/src/compile.ts` (what the build
accepts), `packages/core/src/index.ts` (what is exported), and the Android runtime. Line numbers match the working
tree that includes step P.2 (permissions, launches, `Os`, `detached`, `zn://app-icon`). *(Superseded: steps P.3 and
after were not built then. They are built now; see the updates below. Links are now to files and names, not line numbers.)*
**Updated 2026-11-03** for P.3b–P.6 (rows for dark mode, scanner, media, WebView, auth, native views, background tasks,
secure screens). Those rows link to files, not lines, and were not re-checked by a second reviewer.
**Updated 2026-11-04** for the plugins built since: location, PDF, push (messages, local notifications, OTA check push),
and Firebase (app, Crashlytics, Analytics, Remote Config, Performance). Still missing: maps, biometrics, video, contacts.
`nav.pushForResult` and `onNavResult` are built.
**Updated 2026-11-03 again** for the RN basics pack: `Alert`, `Clipboard`, `Share`, `Linking`, `Platform`, `Dimensions`,
`PixelRatio`, `Keyboard` listeners, `AppState`, `Vibration`, `ToastAndroid`, `NetInfo`, `URL`, `requestAnimationFrame` and
`TextField` `ref`. They keep their RN names and are imported from `@zero-native/core`. Guide: [guide-notes.md](guide-notes.md) §39.
What the reference app uses most is in [§11](#11-what-the-reference-app-uses-most-zerobill).

**Status words**
- **same**: same name and same meaning. Copy the code.
- **renamed**: same idea, different name or value. Change the name.
- **different**: the idea exists but works another way. Read the "how to move" line.
- **missing**: no equivalent today. The line says what to do instead, or what is planned.

## 0. Four big differences to know first

1. **Dynamic values at runtime (Registry 23).** In Registry 23, zero-native supports dynamic runtime expressions across both appearance and layout properties:
   - Appearance: `color`, `backgroundColor`, `opacity`, transforms, image `src` and `tintColor`, `disabled`, `text`, `value`, `placeholder`, `editable`, `visible`, `accessibilityLabel`, `impressionKey`, `borderColor`, `borderWidth`, `pointerEvents`, SVG `fill` / `stroke` / trims.
   - Layout & Dimensions: `width`, `height`, `minWidth`, `maxWidth`, `minHeight`, `maxHeight`, `aspectRatio`, `flex`, `flexGrow` (mapped to `flex`).
   - Margins & Padding: `margin` and all variants (`marginHorizontal`, `marginStart`, etc.), `padding` shorthands (`padding`, `paddingHorizontal`, `paddingVertical`).
   - Spacing: `gap`, `rowGap`, `columnGap`.
   - Typography & Shape: `borderRadius` and corner radii, `fontSize`, `lineHeight`, `letterSpacing`.
   - Visibility: `display: "none" | "flex"`.
   Structural keys (`flexDirection`, `flexWrap`, `alignItems`, `justifyContent`, `alignSelf`, `position`) remain build-time only because they select the layout container type or coordinate pass; dynamic switching among them uses a ternary (`cond ? <Row>...</Row> : <Column>...</Column>`).
   [`DynamicProps` in registry.ts](../packages/template/src/registry.ts), [styling-and-layout.md](styling-and-layout.md) §9.
2. **No React.** No hooks, no `useState`, no `useEffect`, no context, no `ref`, no `memo`. State is signals, and a
   component body runs once. See [guide-notes.md](guide-notes.md) §1–2.
3. **Unknown props and style keys fail the build.** Nothing is silently ignored.
   See the unknown prop and style key checks in [compile.ts](../compiler/src/compile.ts).
4. **Android only today.** `Platform.OS` is always `"android"`. iOS (SwiftUI) comes later.

## 1. Components

| RN | zero-native | Status | How to move |
|---|---|---|---|
| `View` (column) | [`View`](../packages/ui/src/index.ts) or `Column` | same | `<View>` imported from `@zero-native/ui` is a `Column` (since 2026-11-05, [guide-notes §56](guide-notes.md)). Elsewhere `flexDirection` is still not a style key: pick `Row` or `Column`. |
| `View` (`flexDirection: "row"`) | [`View`](../packages/ui/src/index.ts) or `Row` | same | A `<View>` whose style has `flexDirection: "row"` known at build time is a `Row` (since 2026-11-05). A runtime `flexDirection`, `row-reverse` and `column-reverse` are build errors. `alignItems: "stretch"` in a Row needs a fixed height ([platform-differences.md](platform-differences.md)). |
| `View` (overlay, `position: "absolute"`) | [`Stack`](../packages/ui/src/index.ts) | different | Absolute children work only inside `Stack`. `zIndex` too: on a child of any other element it is a build error (since 2026-11-05; before, it was laid out in the flow), except at a component's root, where the compiler can't see the parent. `left` / `right` are `start` / `end`. Normal children stretch to the Stack's width as in RN (since 2026-11-05), but they overlap instead of flowing down. |
| `View` (plain box) | [`Box`](../packages/ui/src/index.ts) | renamed | Use for a decoration layer or one-child wrapper. |
| `Fragment` / `<>` | `<>...</>` ([compile.ts](../compiler/src/compile.ts), fragments) | same | `<React.Fragment>` is rejected: write `<>`. |
| `Text` | [`Text`](../packages/ui/src/index.ts) | different | Text lives only in `Text`. Top-level `<Text onPress>` and `<Text onLongPress>` supported directly (registry 23; Role `Button` for TalkBack, no ripple/opacity change). Nested `<Text>` spans work, also from data (`{parts.map((p) => <Text>...)}`, `&&`, runtime styles) and with `onPress` on a span (`onSpanPress`, registry 16, since 2026-11-05; guide §18). `allowFontScaling={false}` = `maxFontScale={1}`; `ellipsizeMode="tail"` is accepted (zn always cuts the end) (since 2026-11-05). Missing: `selectable`, `adjustsFontSizeToFit`. |
| `Image` (`source={{ uri }}`) | [`Image src`](../packages/ui/src/index.ts) | renamed | `source={{ uri: u }}` becomes `src={u}`. `require("./a.png")` becomes `src="asset:images/a.png"` (an `assets/` folder next to `src/`). |
| `Image source={{ uri }}`, `resizeMode` | `src`, [`contentScale`](../packages/ui/src/index.ts) | same | Both RN names work (since 2026-11-05): `source={{ uri }}` (also a runtime uri) is `src`; `resizeMode` `cover`, `contain`, `stretch` (= `fill`). `require("./a.png")`, `center`, `repeat`: build errors with a hint. |
| `Image defaultSource` | [`fallbackSrc`](../packages/ui/src/index.ts) | different | `fallbackSrc` shows on **error**, not while loading. For a loading look use `loading="shimmer"`. |
| `Image onLoad` / `onError` / `onLoadEnd` / `tintColor` | same names | same | Registry 15. `e.nativeEvent.source` `{ width, height, uri }`, `e.nativeEvent.error`. For `src` only (a `fallbackSrc` sends nothing). `tintColor` can change at runtime. [guide-notes §43](guide-notes.md). |
| `Image blurRadius` / `Image.getSize` | none | missing | Not built (no use in the reference app). |
| `ImageBackground` | `Stack` + `Image` | missing | Put an `Image` and the content in a `Stack`. A gradient is `backgroundImage` on a style. |
| `Icon` (react-native-vector-icons, svg) | [`Icon`](../packages/ui/src/index.ts) | different | SVG path data in a `.ts` file, fill paths only (strokes work in `.svg` files and `<Svg>`, next rows). No icon font, no `react-native-svg`. New code: `.svg` files (next rows). |
| `react-native-svg` (`Svg`, `Path`, `G`, `Circle`, `Rect`, `Defs`, gradients, `ClipPath`, `Use`) | [`Svg`](../packages/ui/src/index.ts) and the same element names | different | Same names and camelCase props. Compiled at build time into one node: geometry must be known at build time; only `fill`, `stroke`, `opacity` may change. `.map` over a `const` array works; `cond && <X/>` inside `<Svg>` doesn't (use `opacity`). [svg.md](svg.md) §4.2. |
| `SvgXml` / `SvgUri` / `react-native-svg-transformer` (`import Logo from "./logo.svg"`) | `import Logo from "./logo.svg"` ([svg-modules.d.ts](../packages/ui/src/svg-modules.d.ts:1)) | different | The import works with no Metro config; the file is read at build time. `SvgXml` with a string: save it as a `.svg` file. `SvgUri` (remote SVG): missing. Tint with `color` (needs `fill="currentColor"` in the file). [svg.md](svg.md) §4.1. |
| `react-native-svg` `Text`, `TSpan`, `Image`, `Pattern`, `Mask` (non-white), `Marker`, filters | in `.svg` files only (registry 13) | different | A `.svg` file may use `<text>` / `<tspan>` (simple, one line, the phone's fonts), patterns, any mask, markers and filters (blur, drop shadow, colour matrix, ...; below Android 12 a plain shadow or none) ([svg.md](svg.md) §17). As inline `<Svg>` elements: missing, build error with a hint. Image: `<Image>` in a `<Stack>`. Text people read: zn `<Text>` over the SVG. |
| Animated SVG (`Animated.createAnimatedComponent(Path)`, Reanimated `useAnimatedProps`) | part `rotate` / `scale` / `translateX` / trims + `animate` ([svg.md](svg.md) §9) | different | Built 2026-11-03 (registry 11). Say the target value and how it animates; no animated props from JS. `strokeDashoffset` "draw the line" tricks become `trimEnd`. Path morphing (animating `d`): missing from JS; an `.svg` file's SMIL / CSS `d` animation morphs (registry 12, [svg.md](svg.md) §16). `strokeWidth` / `dashOffset` on `.svg` parts (registry 12). |
| Animated `.svg` files (SMIL `<animate>`, CSS `@keyframes` inside the file; loaders from icon sites) | `import Spinner from "./spinner.svg"` | **better** | RN's `react-native-svg` ignores SMIL and CSS animation (the file shows still). zn compiles them into native part animations at build time ([svg.md](svg.md) §15): 104 of 104 real loaders play (§17; 95 before phase 3, 100 before phase 4), path morphing, dash and stroke-width animation, filters, moving along a path (`animateMotion`, CSS `offset-path`) and `begin="click"` (a tap on the Svg) included. Other events (`mouseover`) fail with a hint. |
| `ScrollView` | [`Scroll`](../packages/ui/src/index.ts) | different | Props: `horizontal`, pull to refresh. `refreshControl` works on a vertical `Scroll` (see `RefreshControl`). `contentContainerStyle` works with padding keys only (since 2026-11-05). The padding in `style` also scrolls with the content, unlike RN, so put padding in one place: the build fails if both have it. Use margin for space outside. `showsVerticalScrollIndicator={false}`, `keyboardShouldPersistTaps="handled"` and the speed / iOS props are accepted (since 2026-11-05; zn draws no scroll bar). Missing: `onScroll`, `scrollTo` / refs. Long vertical data must use `List`. `<ScrollView>` itself is a build error that says "use <Scroll>". |
| `FlatList` | [`FlatList`](../packages/ui/src/index.ts) or [`List`](../packages/ui/src/index.ts) | same | `<FlatList data renderItem={({ item, index }) => ...} keyExtractor>` works as in RN (since 2026-11-05, [guide-notes §56](guide-notes.md)); with no keyExtractor the key is `item.key`, then `item.id`, then the index. zn's own names: `key`, `row` (gets the item itself). Speed hints (`initialNumToRender`, `windowSize`, `extraData`, ...) are dropped. `ItemSeparatorComponent` → `gap` (or `rowGap`). `onEndReached` same. `stickyHeaderIndices` same (registry 15). `contentContainerStyle={{ paddingBottom: 100 }}` same (padding keys only); padding in `style` scrolls with the rows too. [lists.md](lists.md). |
| `FlatList` headers, empty, footer | `ListHeaderComponent`, `ListFooterComponent`, `ListEmptyComponent` | same | Supported since batch 2 (2026-11-08). Pass an element (`<Header />`) or component (`Header`). Mounted natively inside LazyColumn / LazyRow; empty state renders automatically when data is empty. |
| `FlatList` `refreshing` / `onRefresh` / `refreshControl` | same names on [`List`](../packages/ui/src/index.ts) | same | Pull to refresh, [guide-notes §41](guide-notes.md). |
| `FlatList` `inverted` | `<List inverted>` | built (registry 19, 2026-11-06) | Same meaning: row 0 at the bottom, for chats. A list flipped with `transform: [{ scaleY: -1 }]` (RN's old trick) is a build error: on Android its fling runs the wrong way. Guide §65. |
| `FlatList horizontal` | `<FlatList horizontal>` or `<List horizontal>` | built (registry 23, 2026-11-08) | Lays rows out horizontally using Compose's `LazyRow`. Cards keep their own width (`definiteWidth = false` unless row sets explicit width). `contentContainerStyle` padding and `gap` work along the row. `stickyHeaderIndices`, `inverted` and pull to refresh fail sideways. |
| `FlatList` `numColumns`, `getItemLayout` | none | missing | Grid: no equivalent. `getItemLayout` is dropped. |
| `SectionList` | none | missing | Flatten sections into one `data` array with header items. |
| `FlatList onViewableItemsChanged` | [`useImpressions`](../packages/core/src/nav.ts) + `impressionKey` | different | Counted natively once a card is visible enough. No scroll events in JS. |
| `.map()` in JSX | `{items.map(i => <Row key={i.id}/>)}` | same | Up to ~100 items. The `key` goes on the row's root. |
| `Pressable` | [`Pressable`](../packages/ui/src/index.ts) | different | `onPress`, `onPressIn`, `onLongPress`, `disabled` same. A handler that is `undefined` does nothing, and a handler that changes is used from the next tap, as in RN ([latest](../packages/core/src/view.ts:80), 2026-11-03). An `onLongPress` that holds no handler at that moment lets a long hold give `onPress`, as in RN (registry 14). `onPressOut` gets `cancelled` (a boolean), not an event. Only `Pressable` takes taps: `onPress` on any other element is a build error (since 2026-11-05). It lays its children out as a column. |
| `Pressable style={({ pressed }) => ...}` | `pressFeedback`, `pressScale`, `pressOpacity`, `highlightColor` | different | The style function is not supported. Pick the effect by prop: native draws it with no JS. |
| `Pressable android_ripple` | same, or `rippleColor`, `rippleBorderless`, `rippleRadius` | same | `android_ripple={{ color, borderless, radius }}` works (since 2026-11-05); `foreground` is ignored. The ripple is on by default (RN's Pressable has none). |
| `TouchableOpacity` / `TouchableHighlight` / `TouchableWithoutFeedback` | same names ([ui/index.ts](../packages/ui/src/index.ts)) | same | Since 2026-11-05, [guide-notes §56](guide-notes.md): a `Pressable` with no ripple. Opacity dims to `activeOpacity` (default 0.2). Highlight draws `underlayColor` (default black) at `1 - activeOpacity` (default 0.85) over the content: close to RN, not the same pixels. WithoutFeedback: no feedback. Since registry 23, `flexDirection: "row"` known at build time is automatically wrapped in a `<Row>` by the compiler, moving child layout keys (`alignItems`, `justifyContent`, `gap`, `rowGap`, `columnGap`) to the Row while box styles and press handlers stay on the Touchable. |
| `Pressable hitSlop`, `testID` | same names | different | Registry 15. `hitSlop`: build-time; each axis reaches its larger side on both sides, and a tap in it loses to another tappable element under the finger. `testID` (every element): the resource id UI tests see. [guide-notes §43](guide-notes.md). |
| `Pressable delayLongPress` | none | missing | The system long-press time. |
| `Button` | none | missing | Build it from `Pressable` + `Text`. |
| `TextInput` | [`TextField`](../packages/ui/src/index.ts) | renamed | See the prop rows below. |
| `TextInput` `value`, `onChangeText`, `placeholder`, `maxLength`, `multiline`, `autoFocus`, `editable`, `autoCorrect`, `selectionColor`, `onFocus`, `onBlur` | same names | same | Set `value` in `onChangeText` synchronously (the field always ends up showing `value`). |
| `TextInput placeholderTextColor` | same, or `placeholderColor` | same | Since 2026-11-05. |
| `TextInput keyboardType` | `keyboardType` | different | Values: `default`, `number-pad`, `decimal-pad`, `phone-pad`, `email-address`, `url`, and RN's `numeric` (= `decimal-pad`, since 2026-11-05). |
| `TextInput onSubmitEditing` | `onSubmitEditing(text)` | different | It gets the text, not an event. Key label: `returnKeyType` (`done`, `go`, `next`, `search`, `send`). |
| `TextInput` `secureTextEntry`, `autoCapitalize` | same names | same | `autoCapitalize`: `none`, `sentences`, `words`, `characters`. |
| `TextInput` `ref.focus()` / `blur()` / `clear()` / `isFocused()` | [`ref`](../packages/core/src/text-field.ts:37) + [`createRef`](../packages/core/src/text-field.ts:21) | different | `useRef<TextInput>(null)` → `createRef<TextFieldHandle>()`; then `ref={r}` and `r.current?.focus()` as in RN. Only on `TextField`. OTP boxes: one hidden field plus drawn boxes ([guide-notes.md](guide-notes.md) §39). |
| `TextInput` `autoComplete`, `textContentType` | `autoComplete`; `textContentType` ignored | same | Registry 17 (2026-11-05, R36): RN's names (`tel`, `tel-national`, `sms-otp`, `one-time-code`, `email`, `name`, `password`, ...) as Android autofill hints. `textContentType` is iOS only: accepted and dropped, as RN does on Android. No credit card hints. |
| `TextInput` `onChange`, `onKeyPress`, `onSelectionChange`, `selection`, `defaultValue`, `inputMode`, `numberOfLines` | none | missing | Use `value` as the initial value. Close the keyboard with `Keyboard.dismiss()`. No key events yet. |
| `ActivityIndicator` | [`ActivityIndicator`](../packages/ui/src/index.ts) or `Spinner` | same | Since 2026-11-05: `size` `"small"` (20 dp), `"large"` (36 dp) or a number; `color` same; `animating={false}` hides it and keeps its space, as on Android. `hidesWhenStopped={false}`: build error. |
| `Switch` | [`Switch`](../packages/ui/src/index.ts) | different | `value`, `onValueChange`, `disabled`, `thumbColor` same. `trackColor={{ false, true }}` works (since 2026-11-05; = `trackColor` + `activeTrackColor`); `ios_backgroundColor` is dropped. It is strictly controlled: set the signal or the thumb does not move. |
| `Checkbox` (community) | [`Checkbox`](../packages/ui/src/index.ts) | different | `value`, `onValueChange`, `color`, `activeColor`. |
| (progress bar libs) | [`Progress`](../packages/ui/src/index.ts) | different | `value` 0–1, omit for endless. |
| (skeleton libs) | [`Shimmer`](../packages/ui/src/index.ts) | different | All shimmers on screen move in step. |
| `Modal` | [`Modal`](../packages/ui/src/index.ts) | same | Registry 15: a full-screen window, your content in it. `visible`, `transparent`, `animationType`, `statusBarTranslucent`, `navigationBarTranslucent`, `onRequestClose`, `onShow`; iOS-only props accepted. For a bottom sheet with drag and detents, `Sheet` is still there. [guide-notes §43](guide-notes.md). |
| `Alert.alert` | [`Alert.alert`](../packages/core/src/alert.ts:39) | same | Android's own dialog with the app's theme, up to 3 buttons, `cancelable`, `onDismiss`. Stays open when the phone turns. `Alert.prompt` is iOS only in RN too. |
| `Dimensions.get` / `addEventListener`, `useWindowDimensions` | [`Dimensions`](../packages/core/src/dimensions.ts:43), [`useWindowDimensions`](../packages/core/src/dimensions.ts:70) | different | Same values (dp, `scale`, `fontScale`). They can't size a layout (§0): use `flex` and `%` there, and these in logic. Read inside JSX or `effect` to follow changes. Not ready at a file's top level. |
| `PixelRatio` | [`PixelRatio`](../packages/core/src/dimensions.ts:74) | same | `get`, `getFontScale`, `getPixelSizeForLayoutSize`, `roundToNearestPixel`. |
| `SafeAreaView` / `react-native-safe-area-context` | route option `safeArea` + [`insets()`](../packages/core/src/insets.ts:23) | different | Delete `SafeAreaView`. Set `safeArea` on the route ([`safeArea` in routes.ts](../packages/core/src/routes.ts)); for a coloured header use `insets().top`. |
| `StatusBar` | [`StatusBar`](../packages/ui/src/index.ts) | same | Registry 15: `barStyle`, `backgroundColor` (drawn by zn, works on Android 15+), `hidden`, all at runtime; belongs to its screen. `translucent` does nothing (the route's `safeArea` decides). `StatusBar.setBarStyle` / `currentHeight`: not built (`insets().top`). zn adds `<NavigationBar>`. [guide-notes §43](guide-notes.md). |
| `KeyboardAvoidingView` | route option `keyboard: "resize"` | different | On by default. Delete the component. [`keyboard` in routes.ts](../packages/core/src/routes.ts). |
| `RefreshControl` | [`RefreshControl`](../packages/ui/src/index.ts) | same | Only inside `refreshControl={...}` on a vertical `Scroll` or a `List`, written there (not kept in a variable). `refreshing`, `onRefresh`, `colors` (first colour only), `tintColor`, `progressBackgroundColor`. Other props are a build error. Or use the flat props `refreshing`, `onRefresh`, `refreshColor`, `refreshBackground`. Android's look on both (the disc slides over the content). [guide-notes §41](guide-notes.md). |
| `Animated`, `LayoutAnimation`, `Easing` | `animate`, `enter`, `exit` props, [`Timing`](../packages/ui/src/index.ts) | different | No `Animated.Value`. Say how a change should animate: `animate={250}` or `animate={{ opacity: 200, translateY: "spring" }}`. `enter` / `exit` for mount and unmount. Gesture-driven animation is missing. `Easing.bezier(x1, y1, x2, y2)` → `easing: [x1, y1, x2, y2]`. |
| `Animated.loop`, Reanimated `withRepeat` | timing `repeat` (count or `"forever"`), `reverse`, `repeatDelay` | different | `withRepeat(x, n, true)` → `{ ..., repeat: n, reverse: true }`. RN's `iterations` and zn's `repeat` both count all plays. Needs `from` or `keyframes`. `paused` / `replay` props stop and restart it. [guide-notes.md](guide-notes.md) §22. |
| `Animated.delay`, `Animated.stagger`, Reanimated `withDelay` | timing `delay`; `enter={{ ..., delay: i * 40 }}` for a stagger | different | One delay per timing, each time it starts. |
| `Animated.sequence`, Reanimated `withSequence` | timing `keyframes` + `times` | different | One prop through several values (a shake: `keyframes: [0, -8, 8, 0]`). A sequence across different props or elements: give each its own `delay`. |
| `Reanimated` | none | missing | Same as above. Only opacity, background colour, scale, translate, rotate can animate. |
| `StyleSheet.create`, `flatten`, `hairlineWidth` | [`StyleSheet`](../packages/ui/src/index.ts) | same | Folded at build time. `absoluteFill` / `absoluteFillObject` too (registry 15: an absolute child with both `start` and `end`, or `top` and `bottom`, stretches between them). `flatten` and `hairlineWidth` since 2026-11-05: `hairlineWidth` is 0.4 dp (RN rounds it to one real pixel per phone; a build can't know the phone). |
| `accessibilityLabel`, `accessibilityHint` | same names | same | [`accessibilityLabel` in ui/index.ts](../packages/ui/src/index.ts). |
| `accessibilityRole`, `role` | same names | different | Values: `button`, `header`, `image`, `link`, `text`, `switch`, `checkbox`, `none`. RN's `role` works too (since 2026-11-05; `heading` = header, `img` = image, `presentation` = none). Others are a build error. `aria-label` = `accessibilityLabel`. |
| `accessibilityElementsHidden`, `aria-hidden`, `importantForAccessibility` | same names, or `accessibilityHidden` | same | Since 2026-11-05: `importantForAccessibility="no-hide-descendants"` hides the element and its children; `"auto"` / `"yes"` change nothing; `"no"` (hide only this one) is a build error. |
| `onLayout`, `pointerEvents` | same names | different | Registry 15. `onLayout`: `e.nativeEvent.layout` in dp, on a change. `pointerEvents` as in RN, at runtime too. Without it, an absolute layer with a background or children stops taps as in RN; any other element without handlers lets them through (RN stops them). [guide-notes §43](guide-notes.md). |
| `accessible`, `accessibilityState`, `accessibilityActions`, `ref` | none | missing | No equivalent. Remove them. `accessibilityState` for toggles: use `Switch` / `Checkbox`. |

## 2. Style keys

Types: [`StyleProps`](../packages/ui/src/index.ts), [`TextStyleProps`](../packages/ui/src/index.ts). The real list
is the `Prop` table in [`Prop` in registry.ts](../packages/template/src/registry.ts). Remember: most values must be
known at build time (section 0).

| RN key | zero-native | Status | How to move |
|---|---|---|---|
| `flex`, `width`, `height`, `minWidth`, `maxWidth`, `minHeight`, `maxHeight`, `aspectRatio`, `gap`, `justifyContent`, `alignItems`, `alignSelf` | same | same | `width` / `height` take a number or `"N%"`. `alignItems` has no `baseline`. `justifyContent` has all six values. `gap` works with every `justifyContent` (before 2026-11-05 it was dropped unless `flex-start`); with `space-*` it is the smallest space, as in RN ([second-opinions 112](second-opinions.md)). |
| `margin*`, `padding*` (`Horizontal`, `Vertical`, `Top`, `Bottom`) | same | same | Negative margins are a build error (since 2026-11-05; before, they crashed the app): use `transform: [{ translateY: -8 }]`. Negative padding and border widths too (RN treats them as 0) ([second-opinions 113](second-opinions.md)). |
| `marginLeft`, `marginRight`, `paddingLeft`, `paddingRight` | same, or `marginStart`, `marginEnd`, `paddingStart`, `paddingEnd` | same | Since 2026-11-05 the RN names work in a style. `Left` = `Start`, `Right` = `End`: the same in a left-to-right app; in right-to-left they flip (RN's don't). A `Start` / `End` key written too wins, as in RN. |
| `left`, `right`, `top`, `bottom` | same, or `start`, `end` | same | `left` / `right` work since 2026-11-05 (= `start` / `end`). `position: "absolute"` only for children of `Stack` (a build error elsewhere, since 2026-11-05). |
| `flexDirection` | `Row` / `Column`, or `<View>` | different | On `<View>` it picks Row or Column at build time (since 2026-11-05). On Touchable / Pressable with `flexDirection: "row"`, compiler automatically wraps children in a `<Row>` (registry 23). On other elements: a build error with a hint. |
| `flexGrow`, `flexShrink`, `flexBasis`, `rowGap`, `columnGap` | `flex`, dropped, `gap` | different | Since 2026-11-05: `flexGrow: n` = `flex: n` (two growing children with different content widths split the space a little differently). `flexShrink` 0 / 1 and `flexBasis` 0 / `"auto"` are dropped; other values fail. `rowGap` in a Column (or vertical List / Scroll), `columnGap` in a Row (or horizontal Scroll / Carousel / horizontal List) is the `gap`, and beats `gap`; the other one is dropped. |
| `flexWrap`, `alignContent`, `display` | none | missing | Wrap: no replacement yet. `display: "none"` → `cond && <X/>`. |
| `backgroundColor`, `opacity`, `elevation`, `shadowColor` | same | same | `backgroundColor` and `opacity` can change at runtime. |
| `borderRadius`, `borderWidth`, `borderColor` | same | same | `borderWidth` and `borderColor` can change at runtime (registry 15). |
| `borderTopWidth`, `borderBottomWidth` | same | same | Both use the one `borderColor`. |
| `borderTopLeftRadius` and the other corner keys | same | same | Registry 15. `Left` / `Right` are drawn as `Start` / `End`. |
| `borderStyle` | same | same | Registry 16 (since 2026-11-05): `"solid"`, `"dashed"`, `"dotted"`, for `borderWidth` and the top / bottom lines, with RN Android's dash lengths. |
| `borderLeftWidth`, `borderRightWidth`, per-side colours | none | missing | Nest a `Box`, or draw a divider as a thin `Box`. |
| `shadowOffset`, `shadowOpacity`, `shadowRadius` | accepted, dropped | same | As RN on Android: the shadow comes from `elevation` and `shadowColor` (registry 15 build; no registry need). |
| `overflow` | same | different | `visible` or `hidden` only (`scroll` is missing). |
| `zIndex` | same | different | Inside `Stack`, and since registry 16 (2026-11-05) on a child of `Column`, `Row`, `Box`, `Pressable`: orders it among its siblings, as RN. Not in `Scroll`, `List`, `Carousel` (a build error). |
| `transform` | same | different | `scale`, `scaleX`, `scaleY`, `translateX`, `translateY`, `rotate` (`"45deg"` or a number). zn always draws move → rotate → scale, one value per key: a list whose RN order would draw differently (a scale or rotate before a move, scaleX / scaleY before rotate, a key twice) is a build error (since 2026-11-05). No `skew`, `perspective`, `matrix`. |
| `transformOrigin` | same | built (registry 20, 2026-11-07) | Keywords and percents (`"left"`, `"top left"`, `"50% 100%"`, `["0%", "50%"]`), fixed at build time. Used by scale, rotate, `animate` and keyframes. Lengths (px / dp) and a z value other than 0 are build errors. `left` / `right` are physical, as RN. Guide §68. |
| `backgroundImage: "linear-gradient(...)"` | same | same | Build-time only. Not for radial gradients. |
| `color`, `fontSize`, `fontStyle`, `letterSpacing`, `lineHeight`, `textDecorationLine`, `numberOfLines` | same | same | `numberOfLines` is both a prop and a style key. |
| `fontWeight` | same | different | Numbers 100–900 in steps of 100, `"normal"`, `"bold"`. Strings like `"500"` work too (`compiler/src/compile.ts` `fontWeight`). |
| `textAlign` | same | same | `left` / `auto` = `start`, `right` = `end` (since 2026-11-05 as written; they flip in right-to-left). `justify` is a build error. |
| `maxFontScale` | same | different | New key (RN has `maxFontSizeMultiplier`). |
| `textTransform` | same | same | Registry 15, also on runtime text. |
| `includeFontPadding` | same | different | Registry 16 (since 2026-11-05). zn's default is `false` (RN Android's is `true`): write `true` to get RN's 2-3 dp taller lines. |
| `textDecorationStyle` | same | different | Registry 16: `"solid"`, `"dashed"`, `"dotted"` with an underline or line-through, on a whole `Text` (not a span). RN draws this on iOS only; zn draws it on Android too. `"double"` / `"wavy"` are a build error. |
| `fontFamily`, `textAlignVertical`, `textShadow*`, `userSelect` | none | missing | Only the system font. Custom fonts are not built. With no `textAlignVertical`, a single-line `TextField` centres its text vertically (as RN on Android) and a multiline one starts at the top (RN centres it; apps add `textAlignVertical="top"`) (2026-11-05). |
| `resizeMode` (as a style) | `contentScale` prop | renamed | See Image. `tintColor` on `Image`: see Image. |

## 3. Navigation

zero-native has its own small navigator: a stack of screens, native transitions, back handling. It is not
React Navigation. [`nav` in nav.ts](../packages/core/src/nav.ts), [routes.ts](../packages/core/src/routes.ts).

| RN (React Navigation) | zero-native | Status | How to move |
|---|---|---|---|
| `createNativeStackNavigator` + `Stack.Screen` | [`defineRoutes`](../packages/core/src/routes.ts) + [`startApp`](../packages/core/src/nav.ts) | different | One `routes.ts`: `name: { path, screen, ...options }`. The route order is the number used at runtime. |
| `navigation.navigate(name, params)` / `push` | [`nav.push`](../packages/core/src/nav.ts) | renamed | Names and params are type-checked (register the routes type). Params must be plain JSON: pass ids, not objects. |
| `navigation.goBack()` | [`nav.back`](../packages/core/src/nav.ts) | renamed | Returns `false` on the last screen. |
| `navigation.replace` | [`nav.replace`](../packages/core/src/nav.ts) | same | |
| `navigation.reset` | [`nav.reset`](../packages/core/src/nav.ts) | same | Takes `[{ name, params }]`, bottom first. |
| `route.params` | screen props | different | Params arrive as the props of the screen function. Every `:param` in the path must be a string prop. |
| `useNavigation()` (`goBack`, `canGoBack`, `push`, `replace`, `pop`, `popToTop`, `isFocused`) | [`useNavigation`](../packages/core/src/rn.ts) | same | Since 2026-11-05. No `navigate`: React Navigation's jumps back to a screen already open; use `push` or `goBack`. |
| `setImmediate` / `clearImmediate` | global, [timers.ts](../packages/core/src/timers.ts) | same | Since 2026-11-05: a 0 ms timer; it stops with its screen, as other timers. |
| `useRoute`, `navigation.getState()` | [`useRoute`](../packages/core/src/rn.ts), [`nav.current()`](../packages/core/src/nav.ts), [`nav.depth()`](../packages/core/src/nav.ts) | different | `useRoute()` gives this screen's `{ key, name, params }` (since 2026-11-05). No `getState`. |
| `BackHandler.addEventListener("hardwareBackPress")` | [`BackHandler`](../packages/core/src/rn.ts) or [`useBack`](../packages/core/src/nav.ts) | same | Since 2026-11-05: returns `{ remove() }`; `exitApp()` too. The handler belongs to a screen: the one being built, else the top one, and it stops when that screen closes. Return `true` when you handled it. |
| `beforeRemove` listener | `useBack` | different | Covers the system back only. Make the on-screen back button call the same handler. |
| Screen options: `animation`, `presentation: "modal"` | route `transition: "push" \| "modal" \| "fade" \| "none"` | renamed | [`transition` in routes.ts](../packages/core/src/routes.ts). |
| Deep link `linking` config | route `deepLink: true` + [`onLink`](../packages/core/src/nav.ts) + the app manifest | different | Opt-in per route. Match by path (`zn://<app>/<path>` or the scheme in your `AndroidManifest.xml`). Query values become params. `onLink` can refuse a link. [`ZnNav.kt`, deep link start](../android/runtime/src/main/java/dev/zeronative/runtime/ZnNav.kt). |
| Restore state after the app was killed | route `restore` + [`restorableSignal`](../packages/core/src/nav.ts) | different | The stack comes back by itself. Small values you want back: `restorableSignal` (≤ 4,000 chars of JSON). |
| `useFocusEffect`, `navigation.addListener("focus")` | [`useFocusEffect`](../packages/core/src/rn.ts) / [`useFocus`](../packages/core/src/nav.ts); in a tab `tabs.onFocus(name, fn)` | renamed | `useFocusEffect(useCallback(fn, []))` works (since 2026-11-05). Runs when the screen opens on top and each time the screen above it closes; the returned function runs on blur. `navigation.isFocused()` from `useNavigation()`. Guide notes §40. |
| `navigation.setOptions` / header bar (`headerShown`, `headerRight`, `headerTitle`) | none | missing | There is no header component. Build the header in your screen (a `Row`). |
| Bottom tab navigator (`createBottomTabNavigator`), custom `tabBar` | route `tabs: [...]` + [`useTabs`](../packages/core/src/tabs.ts:56) + `<Tabs>` | different | The tabs live in one screen; the bar is your own JSX (`tabBar` ports straight). Lazy by default (`preload: true` = `lazy: false`), hidden tabs keep their state (`freezeOnBlur`), Back goes to the first tab, the tab comes back after a kill, links reach a tab. `navigation.navigate("stores")` from a tab → `tabs.select("stores")`. Guide notes §40. |
| Drawer, top tabs | none | missing | No drawer. Top tabs: a `Pressable` row over `<Tabs>`, or a `Carousel`. |
| Nested navigators, `navigation.setParams`, `navigation.getParent()` | none | missing | One flat stack. Put state in signals or `restorableSignal`. |
| Await a result from a screen (`navigation.navigate` with a callback / event) | [`nav.pushForResult`](../packages/core/src/nav.ts) and [`onNavResult`](../packages/core/src/nav.ts) | different | Built. Only for native screens (route `native: ...`): the promise gives the screen's answer, or `null` if it closed without one. `onNavResult` hears the answer after a kill. For a JS screen, pass the result through a shared signal or `flowStore` ([plugins.md](plugins.md) §5). |

## 4. Storage

| RN | zero-native | Status | How to move |
|---|---|---|---|
| `AsyncStorage` (`getItem`, `setItem`, `removeItem`, `mergeItem`, `clear`, `getAllKeys`, `multi*`) | [`AsyncStorage`](../packages/core/src/rn.ts) or [`storage`](../packages/core/src/storage.ts:33) | same | `AsyncStorage` from `@zero-native/core` works as in RN (since 2026-11-05): strings, Promises, `null` for a missing key, in its own store. zn's `storage` is synchronous and typed (`getString`, `getNumber`, ...; `undefined` for missing). |
| `react-native-mmkv` (`new MMKV({ id })`) | [`createStorage(id)`](../packages/core/src/storage.ts:163), [`storage`](../packages/core/src/storage.ts:171) | renamed | Same engine and shape (MMKV). `getString`, `getNumber`, `getBoolean`, `set`, `delete`, `clearAll` → `clear`. `onChange` → `onChange`. |
| `redux-persist`, a persisted store | [`persistedSignal`](../packages/core/src/storage.ts:178) | different | A signal that saves itself as JSON. |
| `expo-secure-store` / `react-native-keychain` | [`SecureStore`](../packages/core/src/secure-store.ts) | different | `get` / `set` / `delete`, strings only (≤ 64 KB), async, Android Keystore. `get` returns `null` if the value can no longer be read: treat as "sign in again". No biometric prompt option. |
| (no RN equivalent) crash-safe record | [`flowStore`](../packages/core/src/flowstore.ts) | different | Not in RN. Use it for a payment record that must never be lost. [guide-notes.md](guide-notes.md) §16. |
| `react-native-fs`, `expo-file-system` | none | missing | No file read / write API, in core or in the `media` plugin (media shipped in P.6 with pickers, camera and `edit` only; files are `zn://file` handles). Not planned yet. |

## 5. Network and web APIs

| RN | zero-native | Status | How to move |
|---|---|---|---|
| `fetch` | [`fetch`](../packages/core/src/fetch.ts:368) | same | OkHttp underneath. HTTP errors do not throw: check `res.ok`. Network failures throw [`FetchError`](../packages/core/src/fetch.ts:87) with a `code` (`offline`, `dns`, ...). |
| Differences from RN `fetch` | [fetch.md](fetch.md) | different | Default timeout 30 s, response limit 10 MB ([`setFetchDefaults`](../packages/core/src/fetch.ts:43)). No `res.body` stream. `credentials`, `cache`, `mode` are accepted and ignored. A fetch is not cancelled when its screen closes: use [`useAbortSignal()`](../packages/core/src/abort.ts:114) for that. |
| `Headers`, `Request`, `Response`, `FormData`, `URLSearchParams`, `AbortController` | [`Headers`](../packages/core/src/headers.ts:32), [`Request`](../packages/core/src/fetch.ts:128), [`Response`](../packages/core/src/fetch.ts:182), [`FormData`](../packages/core/src/formdata.ts:39), `AbortController` | same | A file in `FormData` is `{ uri, name, type }` with a `content://` or `file://` uri, as in RN. |
| `XMLHttpRequest`, axios (XHR adapter) | none | missing | Use `fetch`. For axios, use its `fetch` adapter or replace it. Upload progress is missing. |
| `WebSocket` | [`WebSocket`](../packages/core/src/websocket.ts) | same | Browser API shape. Backed by OkHttp (`ZnFetch.client`). 1 MB message cap; text frames only in v1 (second-opinions 161). Sockets stay open in background; closed on dev reload or OTA restart. |
| `NetInfo.fetch` / `refresh` / `addEventListener` (`@react-native-community/netinfo`) | [`NetInfo`](../packages/core/src/netinfo.ts:45) | same | Import from `@zero-native/core`. `type`, `isConnected`, `isInternetReachable` (Android's own "validated" check, no extra request), `details.isConnectionExpensive`. The listener hears the state now, then changes. Still handle `FetchError` code `offline` on each call. |
| `useNetInfo` | [`useNetInfo`](../packages/core/src/netinfo.ts:96) | different | Call it in a screen body; read its fields inside JSX or `effect` to follow changes. |
| `URL`, `URLSearchParams` | installed by the runtime ([url.ts](../packages/core/src/url.ts)) | same | The web standard, tested against Bun. Non-ASCII host names (`https://café.com`) throw a TypeError: no punycode. No `createObjectURL`. |
| `atob`, `btoa` | Hermes | same | Built into Hermes V1. |
| `crypto.getRandomValues`, `structuredClone` | none | missing | Not provided. |
| `setTimeout`, `setInterval` | [timers.ts:57](../packages/core/src/timers.ts:57) | different | Timers made in a screen **stop when the screen closes**. For work that must go on, use [`detached`](../packages/core/src/signals.ts:288). `setImmediate`, `InteractionManager` are missing. |
| `requestAnimationFrame`, `cancelAnimationFrame` | [timers.ts:78](../packages/core/src/timers.ts:78) | different | A timer of about 16 ms, not a real frame; it stops with its screen. Fine for "after this frame"; don't animate with it (use `animate`). |
| `TextEncoder` / `TextDecoder`, `Intl` | installed by the runtime ([text.ts:78](../packages/core/src/text.ts:78)) | same | |
| `console.log` | installed by the runtime | same | |
| `ErrorUtils.setGlobalHandler` | [`onError`](../packages/core/src/errors.ts:37) | renamed | Also sees unhandled promise rejections. |

## 6. Device and OS

| RN | zero-native | Status | How to move |
|---|---|---|---|
| `Linking.openURL(url)` | [`Linking.openURL`](../packages/core/src/linking.ts:14) (also `Os.openUrl`) | different | Same call. Only `http`, `https`, `mailto`, `tel`. Anything else (`upi:`, `intent:`, `whatsapp:`) rejects with `not_allowed`: this is on purpose, so an OTA bundle can't open any app. [`ZnOs.kt`, open URL](../android/runtime/src/main/java/dev/zeronative/runtime/ZnOs.kt:14). Other schemes go through a plugin in Kotlin. |
| `Linking.canOpenURL` | [`Linking.canOpenURL`](../packages/core/src/linking.ts:14) | same | For the 4 schemes above (the runtime's manifest lists them in `<queries>`). False for any other link. |
| `Linking.openSettings()` | [`Linking.openSettings`](../packages/core/src/linking.ts:14) (also `Os.openSettings`) | same | |
| `Linking.getInitialURL()` / `addEventListener("url")` | [`Linking`](../packages/core/src/linking.ts:14) over [`startApp({ onLink })`](../packages/core/src/nav.ts) | different | Read-only copies: only links that matched a route with `deepLink: true` and got past `onLink` reach JS, and their screen is already open. Refuse links in `onLink`, not here. |
| `Linking.sendIntent` | none | missing | Only Kotlin opens another app ([§7](#7-opening-another-app-for-a-result)). |
| `PermissionsAndroid.request` / `requestMultiple` | [`Permissions.request`](../packages/core/src/permissions.ts) | renamed | Takes a list of names: `"camera"`, `"contacts"`, `"location"`, `"microphone"`, `"notifications"`, or a full `android.permission.X`. Returns `granted`, `denied`, `blocked` (RN: `never_ask_again`). The permission must be in the manifest or the call fails with `not_declared`. `"location"` asks for precise and approximate together (as Android 12+ needs), so `granted` can mean approximate only: read `location.precise` in the answer to know. If the manifest has only the precise one, the call fails with `not_declared`. Guide notes §32. |
| `PermissionsAndroid.check` | [`Permissions.status`](../packages/core/src/permissions.ts) | renamed | A permission never asked for reads as `denied`. |
| `AppState.currentState` | [`AppState.currentState`](../packages/core/src/app-state.ts) (also `appState()`) | same | Two states: `active`, `background` (`inactive` never comes, as on Android). It reads a signal, so JSX follows it. |
| `AppState.addEventListener("change" \| "memoryWarning")` | [`AppState.addEventListener`](../packages/core/src/app-state.ts) (also `onAppState`) | same | Returns `{ remove }`. Not called for the state at start. `background` also shows while a permission dialog or a see-through payment window is on top. RN's Android-only `focus` / `blur` events are missing. |
| `Share.share({ message, title }, { dialogTitle })` | [`Share.share`](../packages/core/src/linking.ts:65) | same | Answers `{ action: "sharedAction" }` once the sheet opened, as RN on Android. Android 10+ doesn't show `dialogTitle` for text (RN neither). `url` is iOS only in RN; here it is shared as the text when there is no `message`. No files. |
| `Vibration.vibrate(ms \| pattern, repeat)`, `Vibration.cancel` | [`Vibration`](../packages/core/src/vibration.ts:33) | same | The app's manifest needs `android.permission.VIBRATE`, as in RN; without it, one warning and no buzz. |
| `expo-haptics` | [`Os.haptic`](../packages/core/src/os.ts) | different | Four kinds: `light`, `medium`, `success`, `error`, no permission needed. On a `Pressable`, `haptic` gives a tick on press. |
| `Clipboard.setString` / `getString` / `hasString` (`@react-native-clipboard/clipboard`) | [`Clipboard`](../packages/core/src/clipboard.ts:11) | same | Import from `@zero-native/core`. Text only. `getString` gives "" while the app is not in front (Android 10+). |
| `DeviceInfo`, `expo-application` | [`Os.info`](../packages/core/src/os.ts) | renamed | `appVersion`, `appBuild`, `packageName` (2026-11-06), `android`, `sdk`, `model`, `manufacturer`. |
| `react-native-device-info` | [`@zero-native/device-info`](../plugins/device-info/README.md) | same | Same names and values on Android, default and named imports. Fixed values (`getVersion`, `getBundleId`, `getUniqueIdSync`, ...) are sync, also at module level: native hands them over before the JS starts (core `nativeConstants`). Changing values (battery, disk, network) are Promises only: no `Sync` form. `hasNotch` from the real screen cut-out. Not built: hooks, change events, `getInstallReferrer` (answers "unknown"). Added 2026-11-06. |
| `Platform.OS`, `Platform.Version`, `Platform.select`, `Platform.constants` | [`Platform`](../packages/core/src/platform.ts:35) | same | `OS` is always `"android"`; `Version` is the API level. Native sends the values after the main script: at a file's top level `Version` reads 0 (with a warning). `constants`: `Release`, `Model`, `Brand`, `Manufacturer`, `Version`. |
| `Appearance`, `useColorScheme` | [`Appearance`, `useColorScheme`](../packages/core/src/rn.ts), [`colorScheme`](../packages/core/src/appearance.ts), `scheme(light, dark)` | different | Since 2026-11-05: `Appearance.getColorScheme()`, `addChangeListener(...).remove()`, `useColorScheme()`. A body runs once, so a value kept in a variable doesn't follow a later change: read it inside JSX, or use `scheme(light, dark)`. Templates draw before JS, so a dark phone can flash light colours at cold start ([guide-notes.md](guide-notes.md) §37). |
| `AppState` `memoryWarning` | [`onLowMemory`](../packages/core/src/appearance.ts) | renamed | Coil's memory cache is cleared for you. |
| `I18nManager.isRTL` | `(await Os.info()).rtl` | renamed | `start` / `end` style keys follow it. The app's manifest needs `supportsRtl`. |
| `react-native-screenshot-prevent`, `FLAG_SECURE` by hand | route option `secure: true` | different | Blocks screenshots while that route is on top. |
| `AppRegistry.registerHeadlessTask` | [`defineTask`](../packages/core/src/tasks.ts) | renamed | Called at the top of `main.ts`. A Kotlin plugin starts it with `ZnBackground.run`; it gets a time limit and an `AbortSignal`. `@zero-native/push` runs its messages, new tokens and swipes as tasks. |
| `Keyboard.dismiss()` | [`Keyboard.dismiss`](../packages/core/src/keyboard.ts:64) | same | Returns a Promise (RN: nothing); calling it without `await` is the same. |
| `Keyboard.addListener("keyboardDidShow" \| "keyboardDidHide")`, `isVisible`, `metrics` | [`Keyboard`](../packages/core/src/keyboard.ts:64) | same | As RN on Android: no `Will` events. One event per show or hide; height in dp from the bottom of the window. The route option `keyboard: "resize"` already moves the content. |
| `ToastAndroid.show` | [`ToastAndroid`](../packages/core/src/toast.ts:23) (also `toast()`) | same | zero-native's toast: above the keyboard, survives navigation. `showWithGravity`: the gravity is ignored. |
| Self-update (CodePush, `expo-updates`) | [`Updates`](../packages/core/src/updates.ts:76) | different | Signed OTA bundles. See [ota.md](ota.md). |
| Camera / QR scan (`react-native-vision-camera`, `expo-camera`) | [`@zero-native/scanner`](../plugins/scanner/README.md) | different | QR and barcodes only, no photo or video. A full screen (route `native: "scanner.full"` + `nav.pushForResult`) or a view (`<QrScanner>`). ML Kit is bundled. |
| Document scanner (`react-native-document-scanner-plugin`) | [`@zero-native/document-scanner`](../plugins/document-scanner/README.md) `DocumentScanner` | different | `scanDocument({ maxNumDocuments })` → `{ status: "success" \| "cancel", scannedImages }` as in RN, plus `pages`, `pdf` (`formats: ["jpeg", "pdf"]`), `mode`, `galleryImport`, `tag`, and statuses `lost`, `unavailable`, `failed` with a `reason` (RN rejects). `scannedImages` are `zn://file` handles, not paths: send `pages[i].uri` with `FormData`. No `croppedImageQuality`, no `responseType: "base64"`. ML Kit's scanner is a Play services download: `getStatus`, `download`, `onStatus`. After a kill: `onResult`. Android only. |
| Image / file picker, PDF | [`@zero-native/media`](../plugins/media/README.md) | different | `Media.pickPhotos`, `pickFile`, `takePhoto`, `edit`. Files come back as `zn://file` handles plus a `file://` uri for upload. Results survive a kill (`Media.onResult`). |
| PDF view (`react-native-pdf-renderer`, `react-native-pdf`) | [`@zero-native/pdf`](../plugins/pdf/README.md) | different | `<PdfView source>` (scroll, pinch, double tap, `maxZoom`, `pageGap`, `onPageChange`, `onError`) and `<PdfPreview>` for a card (RN: `singlePage`, but fit to width). `source` is a `zn://file` handle, not a path: get one with `Pdf.download({ url, headers, key })`, which caches. No base64, password, share or links. |
| Full-screen image viewer (`react-native-image-viewing`, `react-native-image-zoom-viewer`, a gesture-handler zoom screen) | [`@zero-native/image-viewer`](../plugins/image-viewer/README.md) `ImageViewer.open` | different | A call, not a component: `ImageViewer.open({ images, imageIndex })` opens a native screen (the app adds a route `native: "imageviewer.full"`) and gives `{ index }` when closed, in place of `visible` + `onRequestClose`. Same names: `images: [{ uri }]`, `imageIndex`, `swipeToCloseEnabled`, `doubleTapToZoomEnabled`, `backgroundColor`; zoom-viewer's `index` and `{ url }` also work. Pinch 1x–5x (down to 0.8x, springs back), pan, double tap 2.5x, swipe between and to close, Back. Links: https (with per-picture `headers`), `asset:`, `zn://file`, `content://`, `data:image/...;base64` up to 5 MB, and `file://` only inside the app's own folders (RN takes any path; refused here because a bundle comes over the air). Headers and `data:` are kept in memory, so after a kill those pictures show an error. No `HeaderComponent` / `FooterComponent`, `onLongPress`, save, live `onImageIndexChange`. Added 2026-11-05. |
| Push (`@react-native-firebase/messaging`) | [`@zero-native/push`](../plugins/push/README.md) `Push` | different | `getToken` answers `{ token, reason }` (RN: throws). `onMessage` and `setBackgroundMessageHandler` are one: `Push.onMessage` runs for every data message in front, behind or closed, with `inFront`. `onTokenRefresh` also runs while the app is closed. Topics, `deleteToken` same. A `messaging()` object keeps RN's names. `getInitialNotification`, `onNotificationOpenedApp` (taps on FCM's own notifications; a tap on the app's own `Notifications.show` opens its `link` through `onLink`), `setAutoInitEnabled`, `requestPermission` / `hasPermission` (Android 13 permission, answers `AuthorizationStatus`) same since native version 2. A data message `zn_ota=check` runs the OTA check natively. Not built: iOS-only calls (APNs). Added 2026-11-04. |
| Local notifications (`@notifee/react-native`, `expo-notifications`) | [`@zero-native/push`](../plugins/push/README.md) `Notifications` | different | `createChannel`, `show` (Notifee's `displayNotification`: big text, big picture, large icon, groups), `cancel`, `cancelAll`, `canShow` (Notifee's `getNotificationSettings` + `isChannelBlocked`). Group summaries are kept for you. A tap opens `link`; with no `link` it calls `Notifications.onPress({ id, data })` or answers `Notifications.getInitialNotification()` (Notifee's `PRESS` event, native version 3); a swipe runs `Notifications.onDismiss`. Title and body take HTML like Notifee's (native version 3). Since native version 2: action buttons with inline reply (`onAction`, Notifee's `ACTION_PRESS` event), inbox lines, progress, `ongoing`, `onlyAlertOnce`, `silent`, badge `number`, `timestamp`, lock screen `visibility` (default private), `category`, `color`, channel groups, `getChannels` / `getChannel`, `getDisplayed` (Notifee's `getDisplayedNotifications`). Scheduled notifications: `schedule(options, { at, repeat, exact })` (Notifee's `createTriggerNotification` with a timestamp trigger; no interval trigger), `getScheduled`, power checks and settings pages. Not built: foreground services, messaging style, full-screen intents. Added 2026-11-04. |
| Firebase app and Installations (`@react-native-firebase/app`, `/installations`) | [`@zero-native/firebase-app`](../plugins/firebase-app/README.md) | same | `firebase.app()` (a promise here; no `options.apiKey`), `setDataCollectionDefault`, `installations().getId()` / `getToken()` / `delete()`. Its Gradle file turns Firebase off when `google-services.json` is missing. Added 2026-11-04. |
| Crash reports (`@react-native-firebase/crashlytics`) | [`@zero-native/crashlytics`](../plugins/crashlytics/README.md) | same | Every JS error is sent by itself (RN: its global handler), with the JS stack, bundle and route keys. `log`, `recordError(error, tag)`, `setAttribute(s)` (also numbers and booleans), `setUserId`, `setCrashlyticsCollectionEnabled`, `crash`. Map JS stacks with `bun run ota symbolicate`. Native crashes need `firebase-crashlytics-ndk`, opt-in. Added 2026-11-04. |
| Remote Config (`@react-native-firebase/remote-config`) | [`@zero-native/remote-config`](../plugins/remote-config/README.md) | same | `setDefaults`, `setConfigSettings`, `fetch`, `activate`, `fetchAndActivate`, `ensureInitialized`, `getValue` (sync: `asString`, `asNumber`, `asBoolean`, `getSource`), `getAll`, `lastFetchStatus`, `onConfigUpdated`, `reset`. Fetch calls answer `{ ok, reason, changed }` instead of throwing. Added 2026-11-04. |
| Performance (`@react-native-firebase/perf`) | [`@zero-native/perf`](../plugins/perf/README.md) | same | App start, every `fetch` (query left out) and a trace per screen with slow / frozen frames by themselves. `startTrace`, `trace(name, fn)`, metrics, attributes, `setPerformanceCollectionEnabled`. Not built: `newHttpMetric`, `newScreenTrace`. Added 2026-11-04. |
| Analytics (`@react-native-firebase/analytics`) | [`@zero-native/analytics`](../plugins/analytics/README.md) | same | On by default, as in RN; `setAnalyticsCollectionEnabled(false)` to opt out. A `screen_view` per route by itself. `logEvent`, `logScreenView`, recommended events (`logPurchase`, `logLogin`, ...), `setConsent`, user id and properties, `getAppInstanceId`. Calls answer true / false; no `isAnalyticsCollectionEnabled`. Added 2026-11-04. |
| Markdown (`react-native-markdown-display`, a custom `MarkDownView`) | [`@zero-native/markdown`](../plugins/markdown/README.md) | different | Since 2026-11-05, JS only. `<Markdown text={md} onLinkPress={(url) => ...} />` and `<MarkdownText numberOfLines={2}>` for one-liners. Headings, lists, quotes, code, lines, bold, italic, strike, `<u>`, code, links. Looks change with `style` / `styles` (span keys), not custom components (`rules`, `components` overrides are missing). No HTML, no images, no tables. Links open only through `onLinkPress`. [guide-notes §58](guide-notes.md). |
| `WebView` (`react-native-webview`) | [`@zero-native/webview`](../plugins/webview/README.md) | different | `<WebView>` with `allowedHosts`, `postMessage` both ways, links that leave the app, cookies, file upload. Debugging is opt-in (`WebViewPlugin(inspect = true)`). |
| Lottie (`lottie-react-native`) | [`@zero-native/lottie`](../plugins/lottie/README.md) `LottieView` | different | `import LottieView from "@zero-native/lottie"`. RN's props and defaults (`autoPlay` false, `loop` true, `speed`, `progress`, `resizeMode`, `renderMode`, `colorFilters`, the `...Android` flags, `cacheComposition`) and events (`onAnimationFinish(isCancelled)`, `onAnimationFailure`, `onAnimationLoaded`). `ref` (callback or `useRef<LottieView \| null>`) with `play(start?, end?)`, `pause`, `resume`, `reset`. Two edits: `source` is `"asset:lottie/x.lottie"` (or `.json`, or `{ uri }` with that text), not `require(...)`; the size goes on a `View` around it (`style` on it is a type error). "Remove animations" shows the last frame. Missing: network URLs, JSON objects, `duration`, `imageAssetsFolder`, text filters, `onAnimationLoop`. Added 2026-11-05 ([guide-notes §57](guide-notes.md)). |
| Phone number hint, SMS auto-read | [`@zero-native/auth`](../plugins/auth/README.md) | different | `Auth.phoneHint`, `Auth.listenForOtp`. Every Play services failure gives a reason, never a crash: show "type it by hand". |
| UPI app list and launch | none | missing | Not in the framework: the app owns this plugin (`plugins.md` D7). `ZnLaunch` and `launches` do the hard part. The icon part is built: `<Image src="zn://app-icon/<package>" />` ([`ZnHandles.kt`](../android/runtime/src/main/java/dev/zeronative/runtime/ZnHandles.kt)). |
| Location (`@react-native-community/geolocation`, `expo-location`) | [`@zero-native/location`](../plugins/location/README.md) | different | `Location.getCurrentPosition` / `watchPosition` answer `{ position, reason }` and never reject. A `Geolocation` object keeps RN's names, callbacks and error codes 1/2/3. Fixes from Android's `LocationManager`, not Play's fused provider. Google's "Turn on location" dialog is `Location.turnOn()` (RN apps call Play's `SettingsClient` in their own module); without Play services, `Location.openSettings()`. Timeout at most 60 s; a watch pauses while the app is hidden. Geocoder included. Added 2026-11-03. |
| Biometrics, contacts, maps, video | none | missing | Not planned yet. `Permissions.request` can ask for the permission, but no API uses it. |

## 7. Opening another app for a result

| RN | zero-native | Status | How to move |
|---|---|---|---|
| `startActivityForResult` in a custom module, `ActivityEventListener.onActivityResult` | [`ZnLaunch.start`](../android/runtime/src/main/java/dev/zeronative/runtime/ZnLaunch.kt) in Kotlin + [`launches`](../packages/core/src/launches.ts) in JS | different | The plugin (Kotlin) builds the Intent and starts it. JS gets the result through `launches.onResult(key, handler)`. |
| Result lost if the app is killed while the other app is open | `launches.pending(key)`, `launches.ack(key, id)` | different | The result is saved on disk **before** JS hears it, and comes again at every start until you call `ack`. Write your handler so it is safe to run twice. [guide-notes.md](guide-notes.md) §31. |
| Start an activity from JS with any Intent | none (on purpose) | missing | JS can't open any app with any data. Only a plugin's Kotlin can. |
| Native screen that returns a value | [`nav.pushForResult`](../packages/core/src/nav.ts) with a route `native: "plugin.screen"` | different | Built. The scanner uses it. See §8. |
| Tell that the user came back, with no result | [`onAppState`](../packages/core/src/app-state.ts) | different | Act on `"active"`, then ask your server. |

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
| `react-native-otp-entry` (`OtpInput`) | [`OtpInput`](../packages/ui/src/index.ts) | same | Built in (registry 18, 2026-11-06, guide notes §62): the same props, ref (`setValue`) and `theme` (written in place, known at build time). A paste keeps the allowed characters; zn adds `error`. `textProps` isn't supported. |
| JS-only npm libraries | allowed if they use no React and no RN modules | different | A plugin that is plain TS can import `@zero-native/core` / `ui`. Anything using React hooks, `View` or `Platform` must be rewritten. |

## 9. React and JS-side patterns

| RN / React | zero-native | Status | How to move |
|---|---|---|---|
| `useState` | [`signal`](../packages/core/src/signals.ts:195) | renamed | `const [a, setA] = useState(0)` → `const a = signal(0)`; read `a()`, write `a.set(1)`. |
| `useMemo` | [`computed`](../packages/core/src/signals.ts:214) | renamed | |
| `useEffect` | [`effect`](../packages/core/src/signals.ts:229), [`onCleanup`](../packages/core/src/signals.ts:259) | different | Runs when the signals it read change. No dependency array. A component body runs once. Return a cleanup function as in RN (since 2026-11-05): it runs before the next run and when the screen closes ([second-opinions 114](second-opinions.md)). |
| `useRef` for a `TextInput` | [`createRef`](../packages/core/src/text-field.ts:21) | different | `ref={r}` on `TextField` only ([§1](#1-components)). |
| `useRef` for a value | [`useRef`](../packages/core/src/rn.ts) | same | Since 2026-11-05: `{ current }`, kept for the component's life; changing it redraws nothing (use a signal for that). |
| `forwardRef`, `useImperativeHandle` | none | missing | A screen body runs once: a plain `let` or a signal does it. |
| `useContext` | module-level signals / imports | missing | No context. Share state through a module. |
| `useReducer`, Redux, Zustand | signals + plain modules | different | Stores that need React hooks do not work. A plain store (Zustand `vanilla`) can be wrapped in a signal. |
| `useCallback` | [`useCallback`](../packages/core/src/rn.ts) | same | Since 2026-11-05: the function itself (a body runs once). `React.memo`: not needed, delete it. `useMemo`: not given on purpose (it would never compute again): use `computed`. |
| `useWindowDimensions` | [`useWindowDimensions`](../packages/core/src/dimensions.ts:70) | different | See §1. Read it inside JSX or `effect`. |
| `useColorScheme` | [`useColorScheme`](../packages/core/src/rn.ts) | different | See §6. |
| Conditional render `cond && <X/>`, `cond ? <A/> : <B/>` | same | same | [compile.ts, conditional rendering](../compiler/src/compile.ts). A branch must be JSX or `null`; nested ternaries work. `return c ? <A/> : <B/>` works (guide notes §47). |
| A value worked out in the body and shown: `const missing = p.amount <= 0` | `computed`, or read it in the JSX | different | A body runs once. Where the value can change, the app build fails with the fix (2026-11-05, guide notes §61): a signal read, or a child's props that can change while it stays mounted. Fine in a screen (route params) and in a `.map` / List row (a row mounts again). |
| Early return in a child: `if (loading()) return <Spinner />` | same | same | Rewritten at build time into branch components (batch 2, 2026-11-08). Top-level guards extract the tail into a child component (`Card__after1`), mounting via nested ternary. Code after the guard runs fresh each time, preventing crashes on unready data. Returns inside loops, try, switch, or nested blocks stay build errors. |
| Destructured props `function Row({ title, size = "md" })` | same | same | Rewritten at build time to `Row(__p)` reading live from `__p` (batch 1, 2026-11-08). Renaming (`{ title: t }`) and literal/constant defaults supported. `...rest`, nested patterns, array patterns, and reassignments stay build errors. |
| `return null` from a child | same | same | Draws nothing, as in React (2026-11-05; was an error that left the part empty). |
| `async function Comp()` | none | missing | A build error: load in an effect, keep it in a signal, show `{data() ? ... : <Spinner />}`. |
| JSX in a variable: `const header = <X/>`, `const badge = c ? <A/> : null` | same | same | Built (compiler pack, 2026-11-04, guide notes §47). Use it in JSX only (child, prop, `return`); each use is its own copy. `let` reassigned and `items.push(<X/>)` are build errors with a hint: one ternary, or `.map`. |
| Early return in a screen: `if (loading) return <Spinner />`, `if (!user) return null` | same | same | Supported since batch 2 (2026-11-08). Top-level guards rewrite to a single return ternary mounting branch components, satisfying the single-template manifest invariant. Refused shapes (switch, loop, try) still fail. |
| Component props, `children` | same | different | `{props.children}` shows them; reading, mapping or counting children is not supported. Spread props `{...p}` are a build error. |
| Custom hooks | plain functions | different | A function that makes signals in a screen body works. |
| `Intl.NumberFormat` etc. | same | same | [guide-notes.md](guide-notes.md) §25. |

## 10. The ten items that would cost a migration the most

Ordered by the work they usually cause. "Missing" and "different" items only.

1. **Runtime changes to layout values** (different). `width`, `height`, `margin`, `flex`, `fontSize`, `borderRadius`
   must be known at build time. Any RN screen that sets these from state needs a redesign: two styles and a ternary,
   or an `animate` prop. Touches almost every non-trivial screen. ([§0](#0-four-big-differences-to-know-first))
   This also hits a value passed in as a component prop: `style={{ height: props.height }}` is a build error, even
   when every caller passes a literal. Common in design-system atoms (button heights, icon sizes). The zero-native way:
   `.svg` icons take a literal `size` where they are used, and atoms list named sizes and pick one with a ternary
   (guide notes §47). A compiler pass that would do this for free numbers was planned and dropped (second-opinions 100).
   Constants in a component body and math on constants (`SIZE / 2`, `COMPACT ? 40 : 48`) are build-time values now.
2. **No React** (missing). Every `useState`, `useEffect`, `useRef`, `useContext`, `useMemo`, and every hook-based
   library (React Query, Formik, React Hook Form, most state libraries) must be replaced. This is a rewrite of screen
   logic, not an edit. ([§9](#9-react-and-js-side-patterns))
3. **Navigation: no header bar, no drawer, no nested navigators** (missing). Bottom tabs and focus events are built
   (`useTabs`, `useFocus`, 2026-11-03), but a header and a drawer must still be built by hand in your screens, and a
   tab can't hold its own stack. ([§3](#3-navigation))
4. **`ScrollView` / `FlatList` features** (different / missing). No `onScroll`, no `scrollTo`, no refs, no
   `SectionList`, no `numColumns`, no list header / footer / empty components (use row
   kinds). Apps that animate on scroll or have grids need a new design. Pull to refresh (`RefreshControl`) is built
   (registry 12, 2026-11-03), and sticky rows (`stickyHeaderIndices`, registry 15). ([§1](#1-components))
5. **`TextInput` control** (missing, partly built). `ref.focus()` / `blur()` / `clear()` are built (RN basics pack), so
   OTP boxes and "jump to next field" port with small edits. `autoComplete` is built (registry 17). Still no `onKeyPress`, no selection API.
   ([§1](#1-components))
6. **Third-party native libraries** (missing). Every RN native library (camera, maps, WebView, push, file system,
   biometrics, image picker) has no zero-native twin yet, except the official plugins: scanner, auth, WebView, media, PDF,
   location, push, Lottie, document scanner, image viewer, and Firebase (crashlytics, analytics, remote-config, perf). Maps, biometrics and video are still missing. A native view or screen is now a plugin's
   `r.view` / `r.screen`.
   ([§6](#6-device-and-os), [§8](#8-native-modules-and-plugins))
7. **Other apps and results through JS** (different). In RN a module can start any Intent. Here only Kotlin plugins can,
   and results come back through `launches` with `ack`. Every `Linking.openURL("upi://...")` or `intent:` call must
   move into a plugin. ([§6](#6-device-and-os), [§7](#7-opening-another-app-for-a-result))
8. **Styling gaps** (missing). No `flexWrap`, `fontFamily` (custom fonts), per-side border colours. (`textTransform`,
   per-corner radius, `Image` `tintColor` and the iOS shadow keys came in RN props pack 2.) Designs that use them need a
   workaround or a framework change. ([§2](#2-style-keys))
9. **Animation model** (different). `Animated.Value`, `Reanimated`, `LayoutAnimation` and gesture-driven motion do not
   exist. `animate` / `enter` / `exit` cover simple changes only. Drag-to-dismiss cards, parallax, and custom
   transitions need a native component. ([§1](#1-components))
10. **Small OS APIs and web globals** (mostly built). The RN basics pack added `Alert`, `Clipboard`, `Dimensions`,
    `Platform`, `NetInfo`, `URL`, `atob` / `btoa` (Hermes) and `requestAnimationFrame` with their RN names; dark mode
    came in P.6. `WebSocket` added in batch 1 (text-only, 1 MB cap). Still missing: `XMLHttpRequest`. The import line changes to `@zero-native/core`.
    ([§1](#1-components), [§5](#5-network-and-web-apis), [§6](#6-device-and-os))

Two more compiler rules were found by the ZeroBill pilot-flow audit (2026-11-03); the compiler pack (2026-11-04)
settled them:
- **JSX in variables: built.** `const header = <X/>` and `const body = c ? <A/> : <B/>` work (guide notes §47).
  Still build errors, each with a hint: a `let` assigned again (use one ternary) and `items.push(<X/>)` (use `.map`).
- **No NativeWind / Tailwind `className`: not planned.** Every class must be rewritten as a `style` object; apps built
  with NativeWind have hundreds of them. zero-native keeps one styling system (second-opinions 103), and no port tool
  is planned.

Smaller known gaps not in the list: `Button`, `Text` `selectable`, `StyleSheet.flatten`. (`testID`,
`Image` events, `Modal`, `StatusBar`, `pointerEvents`, `hitSlop`, `onLayout` came in RN props pack 2, guide-notes §43.)

## 11. What the reference app uses most (ZeroBill)

<!-- Names a private app: reword ("the reference RN app") in the public-repo pass (docs/second-opinions.md entry 38). -->
Rough counts of member uses in ZeroBill's React Native app (2026-11-03), to order the work. The small APIs are built now
(RN basics pack); the right column says how a use ports.

| API | Uses | Ports as |
|---|---|---|
| `Platform.OS` / `Version` / `select` | 94 / 3 / 1 | same |
| `Linking.openURL` | 18 | same for https, mailto, tel; `whatsapp:` and the UPI launch go through a plugin |
| `AppState.currentState` / `addEventListener` | 13 / 13 | same |
| `Keyboard.addListener` / `isVisible` / `metrics` | 6 / 4 / 3 | same |
| `Alert.alert` | 8 | same |
| `Dimensions.get` / `useWindowDimensions` | 6 / 4 | different: values that size a layout must become `flex` or `%` |
| `NetInfo.fetch` / `addEventListener` | 4 / 2 | same (import line changes) |
| `Vibration.vibrate` | 4 | same; for a tap feel prefer `Os.haptic("light")` |
| `ToastAndroid.show` | 3 | same |
| `Clipboard.setString` | 3 | same (import line changes) |
| `Share.share` | 2 | same |
| `BackHandler.addEventListener` | 3 | renamed: `useBack` |
| `Linking.getInitialURL` / `addEventListener` | 1 / 1 | different: the app's link router becomes routes with `deepLink` + `onLink` |
| `<StatusBar barStyle>` | 2 | same (registry 15); the "only while focused" trick isn't needed |
| `react-native-otp-entry` (login) | 1 screen | same: `<OtpInput>` (registry 18, guide-notes §62) |
