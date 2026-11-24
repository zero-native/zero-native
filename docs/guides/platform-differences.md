# Platform Differences & Parity

`zero-native` renders with **Jetpack Compose** on Android and **SwiftUI + UIKit** on iOS. We aim for *"the same design, native on each OS"* rather than forcing artificial pixel identity at the cost of native feel or bundle size.

---

## 1. Intentional Platform Differences

| Area | Android (Compose) | iOS (SwiftUI + UIKit) |
|---|---|---|
| **Shadows** | `elevation` and `shadowColor` cast a shadow from the shape, with or without a `backgroundColor` (`shadowOffset` / `shadowOpacity` / `shadowRadius` are ignored on both platforms) | Same props and rules. Drawn as a soft shadow: y = `elevation` / 2, blur = `elevation`, 20% of `shadowColor`. The shadow shows only outside the shape, so a translucent or empty elevated box stays see-through (as on Android) |
| **Text metrics** | Android text engine; line height and wrapping can differ by 1–2 px | CoreText / UIKit text engine |
| **Back navigation** | Hardware back + Android 13+ predictive back gesture | Edge swipe-back gesture |
| **Failed start recovery** | Error screen offers "Restart app" | iOS apps cannot relaunch themselves; prompts user to reopen |
| **External app results (e.g., UPI)** | Activity result callback (`launches`) | URL scheme app switch + return link; always verify with your server |
| **OTP autofill** | SMS Retriever (`@zeronative/android-play-auth`) + `autoComplete="sms-otp"` | Native iOS `.oneTimeCode` keyboard autofill |
| **Screenshot blocking (`secure: true`)** | `FLAG_SECURE` hides screenshots & recents | Screenshots, screen recording and mirroring show the screen blank (a secure text field's canvas); the app switcher shows a plain cover. iOS can't refuse a screenshot as `FLAG_SECURE` does; Alerts aren't covered |
| **Minimum OS** | Android 7.0 (API 24) | iOS 17.0 |

**Same on both platforms, different from React Native:** in a `Row`, children stretch to the Row's height only when
the Row has a fixed height and `alignItems` or `alignSelf` is `"stretch"`; an unset `alignItems` places them at the top
(`flex-start`), because stretching to an unknown height needs a slow intrinsic measurement. Write `alignItems:
"stretch"` and a height for React Native's look (see [Styling and layout](styling-and-layout.md)).

---

## 2. Current Feature Parity Status (Pre-1.0)

Android is the reference implementation and is in production. iOS now has every feature in this table (checked on the simulator; some checks still need a real iPhone, see §3). What stays different on purpose is in §1 and in §3 "Different by design".

| Feature | Android | iOS | Notes |
|---|:---:|:---:|---|
| Core layout (`Column`, `Row`, `Stack`, `Scroll`, `flexWrap`, safe areas) | ✅ | ✅ | Verified against the LayoutLab conformance suite |
| Signals, compiled templates, Hermes bytecode, MMKV, `FlowStore`, `SecureStore` | ✅ | ✅ | Shared C++ core |
| Navigation, tabs, deep links, back handling, process-death restore | ✅ | ✅ | Nav3 (Android) / `UINavigationController` (iOS) |
| `fetch` (timeouts, `FormData`, error codes) | ✅ | ✅ | Progress callbacks and the network-change pool flush on both; iOS `FormData` file parts take `file://` (no `content://`), written to a file first and uploaded from it |
| `<List>` (virtualized, sticky headers, inverted, pull-to-refresh) | ✅ | ✅ | — |
| `<Sheet>`, `<Modal>`, `Alert`, `toast`, `<OtpInput>`, `<Svg>`, `<Carousel>` | ✅ | ✅ | The iOS Sheet's default corner is 10 pt (Android 24 dp) |
| `<Scroll>` pull-to-refresh | ✅ | ✅ | Android draws its disc (`ZnPullRefresh.kt`); iOS keeps UIKit's spinner (`ZnTabsRefresh.swift`), with a disc only with `refreshBackground` |
| Declarative `animate`, `enter`, `exit` | ✅ | ✅ | — |
| OTA updates (signed bundles, rollback, launch gate, `zn-updates`) | ✅ | ✅ | bsdiff (`znbsdiff1`) patches on both |
| Live reload (`zn dev`) | ✅ | ✅ | Simulator with no setup; an iPhone with `zn dev --lan` (Bonjour, Debug builds only; built, not yet checked on a phone) |
| UI-thread motion & gestures (`useMotion`, `derive()`, `usePan`, `sharedTag`, `animateLayout`) | ✅ | ✅ | The real engine in every iOS build since 2026-11-24 (host API 10). Older iOS builds have a stub: see §3 |
| Runtime layout slots (`width`, `height`, `min/max`, `flex`, `gap`, `aspectRatio`, radii, `top/bottom/start/end`, `fontSize`, `lineHeight`, `letterSpacing`) & `display: "none"` | ✅ | ✅ | — |
| `<Canvas>` (2D draw commands) | ✅ | ✅ | Core Graphics on iOS |
| `WebSocket` | ✅ | ✅ | `URLSessionWebSocketTask` on iOS |
| Custom `fontFamily`, `Text` `selectable` / `adjustsFontSizeToFit` / `minimumFontScale` | ✅ | ✅ | — |
| `accessibility*` props, Dynamic Type font scaling, `testID` | ✅ | ✅ | — |
| `TextField` `editable`, `placeholderColor`, `selectionColor` | ✅ | ✅ | — |

*(Plugin-by-plugin Android/iOS support is listed in [Plugins](plugins.md#1-official-plugins).)*

---

## 3. iOS Gaps in Detail

The list from a sweep of the iOS code after the gap rounds (2026-11-24, release gate item 8). "Ignored" means the app
builds and runs, and iOS draws the element as if the prop were not there. Nothing here crashes. Check this list before
you ship a screen to iOS. Most items below are small differences in how a working feature behaves; the real gaps are
marked **gap**.

### Before you ship to iOS: the ones that matter most
- **Motion bundles and older iOS builds.** Since 2026-11-24 iOS registers the real engine as Motion v1 in every build,
  with the same functions as Android (`tools/test/motion-coverage.test.ts`, which also checks that Release registers
  it). Host API 10 (native only) marks it. iOS apps below 10 have a stub, where every motion call answers
  "unavailable". The update server sends them no bundle that requires Motion, and it knows them by
  `capabilities.os` or `store.os` ([ota.md](../ota.md) §3.2). Ship an App Store build with host API 10 before you send
  a bundle that uses motion (or the TSX image viewer) to iOS users.
- **Checked on the simulator only, not yet on an iPhone** (the full list: [milestones-ios.md](../milestones-ios.md) §12):
  - a real background launch (a silent push, a BGTask), checked only with simulated launches;
  - `zn dev --lan` on a phone (Bonjour and the Local Network prompt);
  - secure screens (`secure: true`) under a real screenshot, screen recording and mirroring;
  - one real OTA update (download, apply, rollback);
  - the camera, UPI apps, universal links, VoiceOver and RTL (ZeroBill's App Store builds may already cover the
    first three);
  - the per-frame motion cost: about 5 ms of main thread per frame for 30 bound elements (4.8 ms Release, up to 5.9
    with blur, 3D and corners; about 2 ms of that is a fixed cost per frame, then about 0.1 ms an element), measured
    at 60 Hz on the simulator, not on a 120 Hz iPhone.
- **A Switch or Checkbox inside a Pressable:** on iOS the control takes its own tap and the row doesn't fire
  (innermost wins, since 2026-11-24); on Android both fire until ZnSwitch / ZnCheckbox keep the touch (A53).
- **A route with `transition: "modal"` closes on a drag down on iOS** (since 2026-11-25, as iOS's own sheets): past
  30% of its height or a downward flick it closes as `nav.back()`, a shorter drag springs back, a Scroll inside hands
  the pull over only at its top, shared elements follow the finger, and a screen with `useBack` asks JS and doesn't
  move. Android closes it with the system back.
- **The screens under a see-through screen and VoiceOver:** route option `accessibilityHidesBelow: true` (with
  `transparent: true`; set on the TSX image viewer's route) hides them from VoiceOver while it shows, and focus goes
  back to the opener on close (iOS, 2026-11-24). Android ignores the option for now, so TalkBack still reaches them
  (A100).

### Components and props
- **`<Text>`:**
  - `selectable` is a whole-text Copy / Share menu (part of the text can't be selected, unlike Android). Not on a Text
    with `onPress` / `onLongPress`.
  - `adjustsFontSizeToFit` + `minimumFontScale` work with `numberOfLines`, in a Row with no flex and centred too. The
    text shrinks smoothly, not in 0.5 sp steps.
  - Text sizes follow Dynamic Type through the same scale JS gets from `PixelRatio.getFontScale()`, and change live,
    field heights included. `maxFontScale` and `allowFontScaling={false}` cap the scale, spans included. iOS's
    accessibility sizes go up to about 2.8× (Android stops at 2.0×), and its curve differs (UIFontMetrics' body
    curve: xxLarge 1.183, AX5 2.817). SVG text and Icon sizes are not scaled, as on Android. OtpInput digits grow
    inside fixed 44×60 boxes, as on Android.
  - `fontFamily` comes from the bundle's font table (`assets/fonts`), from the running OTA bundle or else the app; it
    is never registered system-wide. Faces are picked by weight and style with CSS matching, per span, in TextField
    and OtpInput too. Android's names (`serif`, `monospace`, `sans-serif-*`) map to the phone's fonts. An iOS family
    name from data picks its face by weight and style; a face name is that face. A family with no italic is slanted;
    one with no bold face uses its nearest face (Compose fakes bold).
  - A Text in a box taller than its text draws at the top on both platforms.
  - `numberOfLines={0}` means no limit on iOS (React Native's meaning). Android passes 0 to Compose, which refuses
    it (A105).
- **`<TextField>`:**
  - `autoCapitalize` / `autoCorrect` follow Android's rules; spell checking follows `autoCorrect`.
  - `placeholderColor` is `#9CA3AF` when not written, single-line and multiline.
  - `selectionColor` tints the cursor, the handles and the highlight (the highlight is UIKit's lighter shade, not
    Android's 30% alpha). When not written it is currently the app's tint (Android uses the text colour).
  - A multiline TextField with `maxHeight` (or a set height, or the room left in a full Column) stops growing there and
    scrolls inside, keeping the cursor in view, as on Android. iOS does not hand a drag at the inner scroll's end on to
    the outer Scroll.
  - `returnKeyType="next"` moves focus to the next field in reading order and keeps the keyboard up, as on Android.
    Reading order runs right to left in right-to-left layouts. In a List, the List's own next rows come first,
    including rows below its edge. iOS only: it passes over read-only fields and fields under `pointerEvents` "none"
    (Android can focus them); on the last field it closes the keyboard (Android may wrap around); "done" blurs the
    field (Android keeps focus).
  - `letterSpacing` and `textDecorationLine` are drawn on the text and the placeholder, as on Android. A multiline
    field also draws `lineHeight` and `textAlign`. A single line ignores `lineHeight` on both platforms. `textAlign`
    start and end follow the layout direction.
  - A TextField or link Text on a hidden tab, or scrolled out of its Scroll or List, doesn't block taps on Pressables
    drawn there.
  - Typing very fast into a field that `onChangeText` reformats keeps every key on iOS (since 2026-11-25, A93: JS's
    value goes in with `replace(_:withText:)`). JS's reformat clears the field's own undo history, as before.
- **Accessibility:**
  - A Pressable is one VoiceOver element: a button unless its role says otherwise. Disabled reads "dimmed"; a "Long
    press" action is offered while JS has a handler. With a control inside, the controls stay their own elements and
    the Pressable is still an element read first: its label, or its plain texts. A labelled box with a control inside
    is the same.
  - Roles "link", "text" and "none" on a Pressable or a tappable Text read as a link, as text, or with no role
    (Android: a button, A50).
  - A hint is read after the element, on every node (Android: the "double tap to …" label, on Pressables only).
  - A labelled Image, Svg or Canvas is an image. A labelled Icon or Shimmer is read by its label. An unlabelled
    picture is skipped, even with a `testID`, so a UI test can't find it.
  - A role without a label only adds its trait; the children stay separate. A label from a signal that becomes
    undefined reads as if none was written. `accessibilityHidden` hides the whole subtree.
  - `testID` is the `accessibilityIdentifier`. A plain container with a `testID` becomes a container element
    (XCUITest: `otherElements[id]`). Fields carry it on their UIView; a NativeView's `testID` is a container element
    around the plugin's view (as Android's testTag on the Box around it). `<NativeView testID pointerEvents>` compiles on
    both since 2026-11-25 (A112).
  - A Pressable's accessibility frame includes its touch area (`hitSlop`, grown to the 44 pt minimum; Android: the
    layout bounds only).
  - With `accessibilityHidesBelow: true` on a see-through route (the TSX image viewer has it), VoiceOver skips the
    screens below and focus returns to the opener on close; Android ignores it for now (A100).
- **Touches:**
  - Every Pressable takes taps up to Apple's 44 pt minimum (its `hitSlop` grown evenly; `hitSlop` only adds). Where
    two grown areas meet, the nearer Pressable takes the tap. Android uses Compose's 48 dp.
  - A Pressable gives a tap only to a Pressable inside it that shows under the finger, as Compose's hit test: clipped,
    hidden or covered Pressables never take it. A Sheet's or Modal's Pressables are never inside the Pressable around
    it.
  - A Scroll, Carousel or List that can scroll inside a Pressable takes the swipe, and a tap on it presses the
    Pressable. Under `pointerEvents` "none" or "box-only" the Pressable keeps every touch. A plugin view that handles
    touches (a WebView) keeps them; one that only draws (Lottie) doesn't. On iOS a swipe that starts within 150 ms
    sends no `onPressIn` / `onPressOut`; Android sends both, the out cancelled.
  - A press inside a scroll on iOS starts after UIKit's 150 ms content delay (Android: at once). A quick tap still
    shows the feedback for at least 0.1 s. On a scroll inside a Pressable, `onLongPress` comes 0.5 s after the finger
    went down, as on Android. On a Pressable inside a plain Scroll it comes at about 0.65 s.
  - `pointerEvents` "none" / "box-only" also stop TextField and OtpInput focus and NativeView touches.
  - A Pressable moved, turned or scaled by `transform` takes taps where it is drawn on both platforms, and its ripple
    moves with it. A Pressable inside it wins taps by its size as drawn.
  - In a see-through screen, touches go to Pressables, Scrolls and Lists, fields, tappable Text, enabled Switch /
    Checkbox, plugin UIKit views (including plain UIViews with gesture recognizers) and the error screen; anywhere
    else they reach the screen below (as on Android). SwiftUI-only taps (a plugin's SwiftUI Button, Pressables under
    `ZN_IOS_PRESS=swiftui`) pass through on iOS.
- **Paint:**
  - A rounded Pressable (ripple not borderless) clips its children to its corners on both platforms. On iOS a radius
    from a plain slot clips even at 0, and the clip only affects drawing: taps near the rounded corners aren't cut.
  - `opacity` fades a node and its children as one picture on both platforms. On iOS a node that only draws a fill
    isn't grouped, since it looks the same.
  - `rippleColor`'s own alpha is ignored on both platforms: the ripple uses 24 %, or `rippleOpacity`.
  - Sheet, Modal, StatusBar and NavigationBar take no room in their parent on both platforms.
- **`<List>`:**
  - `ListHeaderComponent`, `ListFooterComponent`, `ListEmptyComponent`, `horizontal`, `numColumns` with
    `columnWrapperStyle` (ghost cells keep a short last line's column widths), and the ref's `scrollToIndex` /
    `scrollToEnd` / `scrollToOffset` work as on Android. `scrollToOffset` and a far `scrollToIndex` land exactly, after
    a short correction while row sizes settle (Android estimates an animated offset, A39).
  - `stickyHeaderIndices` with `contentContainerStyle` `paddingTop`: a pinned row sits at the list's top edge on both,
    and `scrollToIndex` to a sticky row goes to its own place.
  - List cells get the screen's environment (hidden tab, `pointerEvents` none, entry), as Compose's locals reach
    Android's rows.
  - `itemAnimation` ("fade" / "move"): moves are found by key and rows glide. An animated change keeps the first row
    on screen in place (as LazyColumn); a change wholly above the screen keeps the place without animating. iOS fades
    the header, footer and empty item; Android jumps (A84).
  - `reorderable` / `onReorder` use UIKit's drag and drop (lift, auto-scroll, VoiceOver drag actions). Not with
    `stickyHeaderIndices` or `numColumns`. Rows JS sends during a drag go in when the drop is done.
  - Image preload has Android's limits. An on-screen picture joins a running preload, so iOS never downloads a picture
    twice; Android may (A83).
  - The scroll extras (`onScroll`, begin / end drag, momentum, `pagingEnabled`, `snapTo*`, `decelerationRate`,
    `keyboardDismissMode`) work as on `<Scroll>`. Offsets are exact on iOS (Android estimates them from item sizes,
    A81) and leave out the refresh spinner. An inverted list's fling velocity follows the content direction.
  - An inverted List at its newest row follows a new newest row: both platforms.
  - A List has no safe area inside, the same as Android: under unsafe edges rows draw under the bars and the screen's
    `safeArea` decides. Not yet in the SwiftUI variant (`ZN_IOS_LIST=swiftui`).
  - The SwiftUI List variant (`ZN_IOS_LIST=swiftui`, for comparison) has the same features as the UIKit list,
    including sideways `scrollToOffset` / `scrollToIndex` with `viewOffset`, on iOS 17 and 18. A drag let go outside
    the list is forgotten after 1 s.
- **`<Scroll>`:**
  - `onScroll` comes at most once a frame (`scrollEventThrottle`). A bounce at an edge sends no `onScroll`; offsets
    are clamped to 0...max (Android has no overscroll offset).
  - On a snap scroll every release sends `onMomentumScrollBegin` and `End`, as Android; on other scrolls only when
    UIKit coasts.
  - A full-screen `<Scroll>` stops at the status bar and home indicator lines (and doesn't cover a
    `<StatusBar backgroundColor>` strip); a route with `safeArea` off on that side still draws under the bar.
  - Pull to refresh `refreshBackground` / `progressBackgroundColor` (Scroll and List): a 40 pt disc with a soft shadow
    under UIKit's spinner (it grows in place instead of sliding). A `refreshing` from JS alone shows the spinner only
    when the scroll is at its top (Android: anywhere), in UIKit's grey until the first pull.
- **`<Carousel>`:** a `"%"` `itemWidth` is that percent of the width inside the padding. At the scroll's end the last
  page is the one shown (its dot, `onPageChange`). A followed Carousel's dots, `onPageChange` and `autoAdvance` go with
  the pages, whether the follow or the user moved them, on both platforms.
- **`<Sheet>`:**
  - `backgroundColor` / `borderRadius` colour the whole card, grabber band included, radius on the top corners. Not
    written: white and iOS's 10 pt (Android 24 dp).
  - `onDetentChange` fires when a drag rests on another detent; nothing on open, close or a spring back.
  - `<Sheet motion={m}>` gives `m.progress` each frame of the drag, the slides and the close, in the default UIKit
    sheet, a fast flick close included (since 2026-11-25). On iOS it reaches 0 at the safe-area bottom (Android: the
    screen bottom). The `ZN_IOS_SHEET=swiftui` variant has none.
- **`<Svg>` filters:**
  - iOS runs the whole filter graph as Android 12+ does: blur, offset, flood, colour matrix, composite (including
    plus and Figma's inner shadow), all 16 blends, merge, SourceGraphic and SourceAlpha.
  - iOS runs it on the CPU with vImage and Core Graphics, 8 bits per channel, in sRGB. Inside a pattern tile (a mask in
    a tile included), or for a region over 4096 px a side, both platforms draw the plain drop shadows instead.
  - iOS only: a region over 4M px is filtered at a lower resolution. Draw time grows with region size (about 15 ms for
    a full-width 1170 px hero with a big blur), so animated full-screen filters may drop frames.
- **`<Canvas>`:**
  - Drawn with Core Graphics: every command, paint, clip, blend mode and shadow; blur; text, paragraphs and images.
    Same checks and warning texts as Android (Xcode console: "zn: <Canvas> commands:").
  - Sizing as Android: no size of its own; an axis without `width`, `height`, `aspectRatio`, stretch or `flex` is 0,
    or its min.
  - Numbers, colours, opacity, stroke widths and path trims that follow motion values redraw only that canvas on each
    frame with no JS, as on Android. A canvas under another screen doesn't draw until it shows again; one only
    scrolled out of sight still draws, as on Android.
  - Blur on linear, radial and sweep gradients uses the same sigma as Android (Skia's 0.57735·r + 0.5 px). iOS blurs
    the painted pixels on the CPU (vImage); a very large blurred shape is blurred at a lower resolution.
  - Still different: with blur plus a shadow the shadow is cast from the sharp shape (Skia blurs both); text uses SF,
    so wrapped lines can break at other words than Roboto; a cut-off path piece is short straight lines; http(s)
    pictures are decoded at the drawn size and not shared with `<Image>`'s memory cache. Of the `zn://` kinds only
    `zn://file` works, as for `<Image>`.
- **Motion props** (no JS per frame, each redrawn by its own modifier): `opacity`, transforms, `rotateX` / `rotateY` /
  `cameraDistance`, `blurRadius`, a motion `backgroundColor`, border radii, `width` / `height`.
  - `self` / `parent` work; a child of a vertical `<Scroll>` reads the content size as `parent` (as Android); inside a
    horizontal Scroll, List or Carousel, `parent` is the viewport.
  - `blurRadius`: iOS blurs on every version; Android only from 12.
  - A motion value in a `<Text>`: `v.format()` shows the number; a raw value shows "" (Android prints control
    characters, A46).
  - Animations off: iOS Reduce Motion counts as Android's "Remove animations". With it on, `animate` and enter jump to
    their end and exit removes the element at once; self-playing values (Svg parts too) show their resting value;
    motion commands finish at once.
  - enter / exit `flip-x` / `flip-y` / `stretch-x` / `stretch-y` turn in 3D and stretch, in HWUI's order (about y,
    then x) with Android's camera distance (A80: check the camera distance on a phone).
  - iOS asks for up to 120 Hz on ProMotion phones (`CADisableMinimumFrameDurationOnPhone` in the sample and the app
    template).
- **Motion values** (`useMotion`, `to` / `sequence` / `decay` / `set` / `stop`, `derive`, `map`, `mapColor`, `follow`,
  `watch` / `read`, `useFrame`) match Android's maths and command rules. A command's delay is wall time, as Android's
  `delay()`; a reload re-sends window values to the new JS. A newer core finishes `to` / `decay` / `sequence` /
  `snapTo` / `zoomTo` at once, logging it once, when Motion answers "unavailable".
- **Gestures** (`usePan`, `usePinch`, `useRotate`, `useTap`, `useLongPress`, `useFling`, groups, `requireToFail`,
  `simultaneousWith`, `manualActivation`, `snapTo`, haptics, `useZoom`) run natively with no JS per frame.
  - A pan, pinch and rotation follow the fingers in the window. Android measures in the node, where it undoes the
    node's own scale and rotation for a pan only. The results differ only when an ancestor is scaled or rotated, or
    when a node scales or turns with its own pinch or rotation (A63).
  - As in Compose, a touch goes to the frontmost gesture node under the finger and the nodes around it, not to a
    sibling it covers or a node a Pressable covers. On iOS a box that blocks touches only through `pointerEvents` (not
    a Pressable) doesn't stop a gesture node under it.
  - The iOS back swipe leaves a horizontal pan alone, using Android's `systemGestureExclusion` rule: the whole node if
    at most 200 pt tall, else the centre 200 pt, only where the node shows. Elsewhere on the screen the back swipe
    works as before.
  - Scrolls, Lists, Carousels and the Sheet's card pan wait for a consuming gesture under the finger, as in Compose. A
    one-axis pan that goes the other way hands the touch to the scroll at the slop (8 pt). With one finger, a pinch or
    rotation lets the scroll go at the slop.
  - `withParent` "after-edge" shares each move with the list inside once the list's own drag has started, as
    Compose's nested scroll.
  - `release.project` projects a flick with UIScrollView's deceleration (0.998) on iOS and spline decay on Android, so
    the same flick can choose a different anchor.
  - Gesture links (`requireToFail`, `simultaneousWith`) work only within one screen, Sheet or Modal, as on Android.
  - Haptic names map to `UIImpactFeedbackGenerator` (light / medium / heavy), `UISelectionFeedbackGenerator`
    (selection) and `UINotificationFeedbackGenerator` (success / error).
  - `useZoom`: pinch around the fingers, drag inside the edges, fling to the edges, rubber bands, double tap,
    `zoomTo` / `reset`, and handing the drag to a Carousel, as on Android. A drag right after a double tap moves the
    photo, not the page (A87).
  - VoiceOver: gestures with an `a11yLabel` get Android's TalkBack actions. A tap is a button, `useZoom` has zoom in /
    zoom out, and each anchor is an action; each of these sends `onEnd` with `accessibility: true`. They go on the
    node's own element when it has one. iOS only: a one-axis pan with no anchors and both bounds is adjustable (swipe
    up / down; A88). Pans with anchors are not.
- **Element values** (`useElementMotion` with `motion={m}`): the box, `pressed`, Scroll `scrollX` / `scrollY`, List
  index / offset / scroll (both variants), Carousel page, pull, and `m.follow(v)`, as on Android, including a follow
  set before the element is laid out. The box is where the element is drawn, transforms included, and follows any
  move of it or around it. During a UIKit screen transition it gives where the screen ends up, not each step.
- **`animateLayout`:** the size animates like `animateContentSize`, and the content is clipped. The place glides from
  the place the parent Column / Row / wrap / Stack gives it in its box, like Android's `positionInParent`. Reduce
  Motion jumps. Differences: a fixed style `width` or `height` animates on iOS (Android likely jumps, A76). Under other
  containers (a Scroll's content root, a List row) the place is in that container's coordinate space.
- **Impressions** (`impressionKey` / `useImpressions`) use Android's rules: threshold 0.35 by default, clamped
  0.01–1; `minMs`; top screen and app in front only; once per screen visit; 500 ms batches, sent at once when the app
  goes to the back or the screen leaves. Keys inside a Sheet or Modal count under the screen, and a hidden tab or
  pointerEvents "none" around a Sheet or Modal reaches its content too, as on Android. The visible box is cut by
  the window, scroll views, clipping views and overflow-hidden nodes; layouts that don't clip don't cut it (Android's
  `boundsInWindow` is cut by every layout around the node), so a keyed node that sticks out of a parent that doesn't
  clip also counts the part outside.

### Routes and navigation
- `transparent: true`: with a transition other than `"none"` the see-through screen animates alone; the screen below
  stays still (Android may move it, A28). `ZN_IOS_NAV=swiftui` (the comparison variant) draws it opaque.
- `sharedTag` works for push, pop, modal and fade routes and the edge swipe, which scrubs the flight and puts it back
  on cancel. An Image flies as its picture; any other element moves its bounds and cross-fades a snapshot of each
  screen's look. There is no flight for transition "none", a push at start, Reduce Motion, a see-through screen's own
  tags (as on Android), Sheets and Modals, or `ZN_IOS_NAV=swiftui`. A push from a screen that has tags starts about
  one frame later, at most three, because the new screen's layout is measured first.
- A screen pushed while the first screens open (before NAV STARTED) comes in with no slide, as on Android.
- A screen that leaves the stack, by back, replace or reset, keeps its instances until its exit animation has ended.
  Covered screens removed by a reset are freed at once. Covered screens keep their views alive on iOS; Android
  disposes their composition.
- A push, back or replace while a screen is still sliding in, or during a back swipe, doesn't blank the new screen or
  drop it from JS's stack.
- The left-edge back swipe goes back over a Carousel or a horizontal Scroll / List too, as Android's system back
  gesture; on a screen with `useBack` it asks JS and the scroll view under it doesn't move.
- **gap:** a `"modal"` route has no drag-down close (see "Before you ship").

### Built-in modules and the runtime
- **`fetch`:** `FormData` file parts take `file://` only (`content://` rejects `invalid_request`); the body is written
  to a file first, so an upload needs free disk equal to its size (the timeout counts the staging). No HTTP/2 ping (a
  connection that dies silently without a network change waits for the call's timeout). Pictures keep their
  connections across a network change ([fetch.md](../fetch.md) §9).
- **Background launches:** JS starts without a window (`ZnApp.prepare` in the app delegate, as Android's
  `Application.onCreate`; `ZnTasks.run` starts it once per process if the app didn't). `defineTask` tasks run in a
  push, a notification button or a background launch. `appState()` is "background" until the window's START. Screens
  come with the window.
  - Tasks keep the app awake: ZnTasks holds UIApplication background time while a task waits or runs (about 30 s in
    all). When iOS ends it, open tasks are aborted, dropped, or answered and kept, as at their answer-by time. Tasks
    restored from an earlier start hold time only once JS has them. A plugin can set `answerByMs` so its caller is
    answered in time. Android doesn't keep the process alive for a task: the plugin's own service or `goAsync` does.
  - Plugins decide between an event and `getInitialNotification` with `ZnApp.tapIsEvent`: with no screens yet, a call
    waiting, or a tap within 1 s of the app first being in front, the tap is kept as the initial tap (Android's launch
    Intent). `getInitialNotification` waits for the screens and the front, at most 10 s.
  - A downloaded bundle that fails while JS runs with no window is blocked and rolled back in place when the window
    opens.
- **Background tasks:** `ZnBackgroundTasks.register(id, jsTask:)` in `didFinishLaunching`, plus
  `schedule(refresh(id, in:))`, runs a `defineTask` task from a BGTaskScheduler task, as a WorkManager job does on
  Android. iOS decides when, never after a swipe-away, and never on the simulator. When iOS ends the time, only that
  run's signal is aborted and the BGTask ends as failed. The id goes in `BGTaskSchedulerPermittedIdentifiers`. Call
  `ZnPlugins.register` or `ZnApp.prepare` in `didFinishLaunching`, so a register too late is refused rather than
  ending the app.
- **`Dimensions` / `PixelRatio`:** `Dimensions`, `useWindowDimensions` and `PixelRatio` update on rotation, split view
  and Stage Manager; `getFontScale()` updates on text size changes. The sample and the template stay portrait-only.
- **Motion `env`** is written by the window's root: width, height, insets, the keyboard height every frame, and the
  keyboard target measured against the window, not the screen. A floating or undocked iPad keyboard counts as 0.
  Sheets and Modals read the same values.
- **Motion plugin API:** `ZnMotionApi.swift` matches `ZnMotionApi.kt`: `Handle.value` / `onDispose`, `onFrame` with a
  FrameToken, `registerDriver` with a public `ZnMotionDriver`, and `reader`. Extra on iOS: `scope.onMotion(name) { v in }`
  for UIKit views. Lottie follows a motion `progress`. `onDispose` adds blocks on iOS; Android's replaces the first
  (A79). A frame call lives until it is cancelled, a JS reload included, on both platforms.
- **`useTilt`:** CoreMotion gravity at 50 Hz (the accelerometer if there is no device motion), turned with the
  interface orientation, with Android's 0.2 low-pass. It stops on resign active and resets when the last user goes.
  No permission is needed. It reads 0 on the simulator. Until Android is fixed, x and y have the opposite sign in
  landscape on Android (A77).
- **OTA patches** (`znbsdiff1`, [ota-patches.md](../ota-patches.md)) match Android. Any failure reports `patch_failed`
  and installs the full zip in the same check; only "no space" fails the check. iOS only: the patch zip's
  `zn-bundle.json` file list is checked against the signed bundle SHA before any file is made (Android checks at the
  end); the built-in base is the app's resources folder (Android: the APK's assets); Debug builds take
  `ZN_OTA_FULL_AT` to make a download fail as on a full phone.
- **Live reload (`zn dev`):** a Debug build on the simulator connects to 127.0.0.1:8082 by itself, with no adb step,
  and one `zn dev` serves Android and the simulator at once. The JS error screen (mapped to TSX), the build-failure
  screen and the missing-module screen match Android. A reload replaces the whole runtime (about 0.4–1.6 s), while
  Android reloads in place, and every open screen opens again by route and params, so screen-local state starts fresh.
  `ZN_DEV=0` turns it off.
  - A real iPhone reaches the Mac over Wi-Fi, because iOS has no adb reverse. Run `zn dev --lan`: Bonjour
    `_zn-dev._tcp`, whose TXT has `app=` and `mac=`. The phone takes only its own app's server and prefers the Mac it
    was built on. Or set `ZN_DEV_HOST` (environment, or the build setting; a build-time one gives way to Bonjour after
    3 failed tries). The first connect asks for Local Network access.
  - Only Debug builds have `NSLocalNetworkUsageDescription`, `NSBonjourServices` and `ZNDevMac` (`ios/cmake/ZnDev.cmake`,
    which keeps an app's own Local Network keys, or the packages template's build phase), so App Store builds never
    ask. Networks that keep devices apart (guest Wi-Fi) block it; there is no USB-only route on iOS yet.

### Plugins
- **`app-updates`:** `isUpdateAvailable` asks the App Store's public lookup, in the App Store account's storefront,
  then the phone's region. It answers `versionCode: 0` plus `storeVersion` and `appStoreId`, and the answer is kept an
  hour. Apple's CDN can lag a release by hours, and the lookup is not a documented API.
  - `start` loads the App Store's own sheet, then shows it inside the app. It isn't refused while busy. It can't be
    full screen, and iOS never says whether Update was tapped: closing it sends `declined` (optional) or `canceled`
    (forced).
  - A forced sheet opens again on each return to the app until a lookup of that same app says there is no update. A
    failed lookup doesn't end it, and it never re-opens while busy.
- **`webview`:** paused / resumed when a screen is on top, the app is in the background, or a system controller is
  presented over it. zero-native's own Sheet and Modal don't pause it (as on Android), nor does a presentation that
  doesn't dim the page (`.overFullScreen`, custom ones). A swipe back changes the state only when it ends. While
  paused, media is suspended.
  - `onUpload` gives the count from Safari's own picker. Inputs in open shadow roots and `showPicker()` pickers count
    too. Uploads off, or a host not allowed, are refused natively on iOS 18.4+. Before 18.4 a page script does it, and a
    closed shadow root or `showPicker()` can get round it there. A closed shadow root's pick or cancel sends no event.
    Picking the same file again may send no event.
- **`document-scanner`:** `galleryImport` asks Camera / Photos in an action sheet, or goes straight to Photos with no
  document camera. On the simulator `getStatus` says "unavailable", but a `galleryImport` scan still works.
  - Pages from Photos are cropped and straightened by Vision and Core Image. `mode` applies only to them: "base" crops
    only; "filter" and "full" add Core Image's document filter. ML Kit's stain and finger removal has no Apple
    equivalent.
  - A sheet, picker or camera closed with no answer (for example by a Sheet closing) ends the scan as a cancel.
- **`image-viewer`:** the TSX viewer's pinch and double tap use `useZoom`, so it needs an iOS build with the Motion
  engine (host API 10).
- **`media`:** the pickers run inside the app. A kill while one is open makes the pick `lost` (Android brings the
  answer back). A camera "no" is `camera_blocked` at once (Android says `camera_denied` first). No camera: `no_app`.
  - `pickFile` types are matched to iOS content types, and one iOS doesn't know matches nothing. `application/*` lets
    any file be picked, and `text/*` also JSON and XML. A package document (.pages, .key) fails with `read_failed`.
  - A photo not downloaded from iCloud in 60 s fails. A new pick within about 1 s of a picker vanishing gets `busy`.
- **`firebase-remote-config`:** the same API. `reset()` answers false (iOS's Firebase has no reset). Defaults are kept
  as text written as Android writes them ("true", "7", "1.0E21").
- **`firebase-perf`:** network traces come from core's fetch on both OSes, with the same `url` rule and `zn_bundle`. A
  redirect the rules refuse is traced with its 3xx on both.
  - On iOS the response size is the body received, unzipped. Methods Firebase doesn't know (PROPPATCH, REPORT) get no
    trace. `ZnFetch.addObserver` hears calls that start after it is added (on Android, `addInterceptor` is refused
    after the first fetch).
  - Firebase's automatic URLSession and view controller traces are off. `PerfPlugin(automatic: true)` (iOS only)
    turns them on (every request, URL without query, no `url` filter, no `zn_bundle`).
  - Register PerfPlugin before FirebaseAppPlugin, and put `firebase_performance_instrumentation_enabled` NO in the
    Info.plist: linking the SDK turns its hooks on by itself.
  - `frames` counts display refreshes (Android counts drawn frames): slow is longer than 1/59 s, frozen longer than
    700 ms.
  - The CMake sample links Remote Config and Performance; run `bun run tools/fetch-firebase-apple.ts` once to download
    them again. CoreMotion is linked for `useTilt`.

### Testing
- UI tests on iOS: XCUITest in the package sample (`ios/SamplePackage/ZnSampleUITests`), found by `testID`. Run with
  `bun run ios:ui-test [--device <simulator>] [--only Class/test] [--dump <route>]`. A nightly CI run is added
  (`.github/workflows/ios-ui-tests-nightly.yml`, first run pending; a failed test runs again once). The test build is unsigned, so Keychain screens need an ad hoc signed
  build.
- The UI tests for the TSX viewer's double tap, pinch and a drag right after a zoom run by default (since 2026-11-25;
  25 of 25 runs, 15 of 15 on a busy Mac).

### Different by design (not planned to change)
These follow what iOS allows. They are not gaps:
- `Modal`'s `onRequestClose` never fires (iOS has no system Back). `Alert`'s `cancelable` is Android only.
- `toast` is zero-native's own pill. It moves with the keyboard and shows at most two lines; an empty message shows
  nothing. `Vibration` has no length. `exitApp` isn't possible.
- New apps are light (`UIUserInterfaceStyle` Light, as Android's Light theme): white launch screen, light Alerts and
  keyboard on a dark phone. `colorScheme()` then says "light" on iOS (React Native does the same with this key);
  Android reports the phone's setting. For a dark app set Dark; for both, remove the key.
- `Os.info` gives `android: ""` and `sdk: 0`, plus an `ios` field. `Os.openUrl` refuses `intent:`, `file:` and
  `javascript:` links.
- `android.permission.*` names answer "denied". The contacts permission needs `ZN_CONTACTS`.
- `NetInfo`'s `isInternetReachable` means "has a route out". SecureStore items are cleared on the first start after a
  reinstall.
- `fetch` joins repeated headers with `", "`, except `Set-Cookie`.
- `ZNStorage` / `ZnStorage.store(id)` (native storage for Swift code) has every type JS has, in the same format, and
  works from any thread. Differences: a getter of another type answers nil (Android throws); set with a bad store id
  or an empty key answers NO and logs it (Android throws); text that isn't valid UTF-8 reads with U+FFFD, as on
  Android.
- `<Scroll>` / `<List>` `decelerationRate` is UIKit's own rate ("fast" is 0.99, numbers used as given).
  `keyboardDismissMode="interactive"` is SwiftUI's interactive dismissal on a vertical Scroll and "on-drag" on a
  horizontal one, and it doesn't stream frames to JS keyboard listeners; "none" or not written never closes the
  keyboard. The pull-to-refresh spinner is UIKit's; the disc only with `refreshBackground`.
- A reorderable `List`'s long press picks the row up, so a row's own `onLongPress` is off on iOS (the compiler warns),
  including Text links and VoiceOver's long press; the header, footer and empty item keep theirs. The drag has
  UIKit's drag-and-drop look (the lift, the rows making room). Android should match (A31, A82).
- Remote pictures are kept on disk in `Caches/zn-images`: up to 200 MB, least recently used first out, whatever the
  cache headers say (as Coil 3 on Android). iOS may clear Caches when the phone is short of space.
- `android-ad-id` has no iOS side. zero-native 0.1.0 has no IDFA plugin (use AdAttributionKit / SKAdNetwork, or a
  separate opt-in ATT plugin).
- `android-play-auth` on iOS answers "unavailable" (`phoneHint` / `listenOtp`; `appHash` is `""`): there is no Play
  services, and apps can't read SMS. `OtpInput` / `autoComplete="sms-otp"` get the code from Messages, and `tel`
  fields get AutoFill.
- `app-updates`: `complete`, the download states and the in-app card are Android only (`complete` answers
  "unavailable").
- `webview`: no `pauseTimers` on iOS.
- `document-scanner`: `download` sends one `status` event, with no "downloading" step. A kill while VisionKit's camera
  is open loses the scan; it is reported as `lost`, so ask the user to scan again.
- `image-viewer` refuses `content://` (Android's ContentProvider scheme). Pass Media's `zn://file` handle or a
  `file://` URI.
- `image-viewer`: sharp zoom parts come from a lazily decoded image (ImageIO) instead of BitmapRegionDecoder. JPEG and
  HEIC are read by rows or tiles. PNG and TIFF over 12 MP are read every nth pixel, other formats only up to 12 MP,
  and GIF gets none. Mirror images get none on both platforms.
- `image-viewer` TSX screen: iOS has no Back button; the viewer closes with its close button or a drag up or down, and
  a left-edge swipe pages back, as in Photos. While it opens see-through (up to about 0.7 s) its layers take touches
  on both platforms, but the close button only answers once it shows on iOS (UIKit skips alpha 0 views).
- `firebase-messaging`: data-only (content-available) messages arrive while the app runs, or as a background wake that
  iOS rations (a few an hour, held in Low Power Mode, none after the user swiped the app away). iOS is answered within
  25 s even when JS isn't running. Send an alert push with `mutable-content` for anything that must arrive.
- Ignored on iOS because there is nothing to map them to: `Text` `includeFontPadding`, `NavigationBar` `barStyle`,
  Location `turnOn` (answers "unavailable"), Scanner `autoZoom`, Lottie `mergePaths` / `opacityToLayers` /
  `safeMode`, WebView `thirdPartyCookies` (can't be turned on), notification channels and exact alarms.
- `device-info` values that exist only on Android answer `"unknown"`, `-1` or `false`.
