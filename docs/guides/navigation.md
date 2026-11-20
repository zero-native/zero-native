# Navigation

Navigation in `zero-native` is **native-driven** (AndroidX Navigation 3 on Android, `UINavigationController` on iOS) with full TypeScript route safety, deep links, bottom tabs, back handlers, and automatic process-death restoration.

---

## 1. Defining Typed Routes

Declare all screens in `routes.ts` using `defineRoutes`. The compiler reads this file at build time so native can draw the first screen's skeleton before JS even starts.

```ts
// app/src/routes.ts
import { defineRoutes } from "@zeronative/core"
import { HomeScreen } from "./HomeScreen"
import { StoreScreen } from "./StoreScreen"
import { CheckoutScreen } from "./CheckoutScreen"

export const routes = defineRoutes({
  home: {
    path: "/",
    screen: HomeScreen,
    tabs: ["home", "offers", "profile"] as const,
  },
  store: {
    path: "/store/:storeId",
    screen: StoreScreen,
    deepLink: true,
  },
  checkout: {
    path: "/checkout/:sessionId",
    screen: CheckoutScreen,
    safeArea: "all",
    keyboard: "resize",
    restore: false, // don't reopen a completed checkout screen after process death
    secure: true,   // blocks screenshots & screen recording on Android
  },
})

// Enables typed nav.push("store", { storeId: "123" }) across your app
declare module "@zeronative/core" {
  interface Register {
    routes: typeof routes
  }
}
```

Start the app in `main.ts`:

```ts
import { installRuntime, startApp } from "@zeronative/core"
import { routes } from "./routes"

installRuntime()
startApp(routes)
```

### Route options
- `path` — URL pattern (`"/"` is the default home route; supports `:param` segments). Route params are JSON-serialized, so pass IDs rather than large objects.
- `deepLink?: boolean` — opt-in per route for external URLs and notifications.
- `safeArea?: "all" | "none" | { top?: boolean; bottom?: boolean }` — native inset handling (default `"all"`).
- `statusBar?: "dark" | "light"` — status and navigation bar icon color (default `"dark"`).
- `keyboard?: "resize" | "none"` — native IME resize behavior (default `"resize"`).
- `transition?: "push" | "modal" | "fade" | "none"` — screen transition style (default `"push"`).
- `restore?: boolean` — whether to reopen this screen after background process death (default `true`).
- `secure?: boolean` — enables `FLAG_SECURE` while the screen is visible (Android).
- `transparent?: boolean` — keeps the screen below visible underneath (e.g., transparent modal overlays).
- `tabs?: readonly string[]` — declares tab names for `useTabs(routeName)`.
- `native?: string` — routes directly to a registered native plugin screen (see [Plugins](plugins.md)).

---

## 2. Navigating Between Screens

Import `nav` from `@zeronative/core`:

```ts
import { nav } from "@zeronative/core"

// Push a new screen with typed params
nav.push("store", { storeId: "42" })

// Replace the current screen
nav.replace("checkout", { sessionId: "abc" })

// Reset the entire stack (bottom first)
nav.reset([{ name: "home" }])

// Go back one screen
nav.back()
```

### Reacting to focus (`useFocus`)
`useFocus(fn)` runs `fn()` (with no arguments) each time the screen becomes the top screen; if `fn` returns a cleanup function, it runs when the screen loses focus:

```tsx
import { useFocus } from "@zeronative/core"

export function HomeScreen() {
  useFocus(() => {
    refreshFeed()
    return () => {
      // runs when another screen opens on top or this screen closes
    }
  })
  // ...
}
```

*(React Navigation aliases `useNavigation()`, `useRoute()`, and `useFocusEffect()` are also exported from `@zeronative/core` for easier porting.)*

---

## 3. Back Handling

Intercept hardware back presses (Android) or confirm before leaving a critical screen with `useBack`.

**Important:** Registering a `useBack` handler disables the native predictive-back gesture on that screen so JS can decide. Register it inside a **conditional part** so it is active only while you actually need to guard the screen:

```tsx
import { useBack } from "@zeronative/core"

function PaymentBackGuard(props: { onConfirmExit: () => void }) {
  useBack(() => {
    props.onConfirmExit()
    return true // handled — keep the screen open
  })
  return null
}

export function CheckoutScreen() {
  return (
    <Column style={{ flex: 1 }}>
      {paymentInProgress() && <PaymentBackGuard onConfirmExit={showConfirmExitSheet} />}
      {/* ... */}
    </Column>
  )
}
```

- Screens **without** a `useBack` handler pop natively with zero JS round-trip (with a 300 ms native fallback if JS is busy), enabling smooth Android predictive back gestures and iOS swipe-back. Screens **with** a handler wait for JS (guarded by the JS hang time limit).

---

## 4. Bottom Tabs

Declare `tabs: ["home", "offers", "profile"]` on your route in `routes.ts`, then call `useTabs("<routeName>")` inside that screen:

```tsx
import { useTabs } from "@zeronative/core"
import { Column, Row, Tabs, Pressable, Text } from "@zeronative/ui"

export function HomeScreen() {
  const tabs = useTabs("home")

  return (
    <Column style={{ flex: 1 }}>
      <Tabs selected={tabs.index()} style={{ flex: 1 }}>
        <Column style={{ flex: 1 }}>{tabs.seen("home") && <HomeTab />}</Column>
        <Column style={{ flex: 1 }}>{tabs.seen("offers") && <OffersTab />}</Column>
        <Column style={{ flex: 1 }}>{tabs.seen("profile") && <ProfileTab />}</Column>
      </Tabs>

      <Row style={s.tabBar}>
        {tabs.names.map((name) => (
          <Pressable key={name} style={{ flex: 1 }} onPress={() => tabs.select(name)}>
            <Text style={{ fontWeight: tabs.selected() === name ? 700 : 400 }}>{name}</Text>
          </Pressable>
        ))}
      </Row>
    </Column>
  )
}
```

- `tabs.seen(name)` ensures each tab is lazily mounted only when first visited, then kept alive in memory without drawing frames while hidden.
- Use `tabs.onFocus(name, fn)` for tab-specific focus effects. Pressing Back on a non-first tab returns to the first tab automatically.

---

## 5. Deep Links

Mark any route with `deepLink: true` in `routes.ts`, and configure your app's custom URL scheme / Android `intent-filter` / iOS Associated Domains in the native host so the OS delivers links to your app.

- Path params (`/store/:storeId`) and query params (`?ref=promo`) are merged into the screen's `props` (path params win on collision).
- Handle unrecognized URLs via `startApp(routes, { onUnmatchedLink: (link) => ... })` or intercept links before navigation with `onLink`.

---

## 6. Process-Death Restoration & `restorableSignal`

Mobile OSes routinely kill background apps (especially on low-RAM Android phones when the user switches to a UPI or banking app).

- **Back stack & route params** are saved natively and restored automatically when the OS recreates your app (not when the user explicitly swipes the app away).
- **`restorableSignal(key, initial)`** saves screen-local state alongside the back-stack entry so form fields or checkout state survive an OS kill:

```tsx
import { restorableSignal } from "@zeronative/core"

export function CheckoutScreen() {
  const note = restorableSignal("note", "")
  // Survives background process death; resets when the user leaves normally.
}
```

- **Limits:** Keep values small (4,000-character limit), non-secret, and serializable JSON. Restored values apply to the same bundle version only.
- For critical financial or idempotent flows, pair this with **`FlowStore`** (see [Data & Networking](data-and-networking.md#5-flowstore-crash-safe-multi-step-flows)).

---

## 7. Splash Hold & App-Wide Layers

### Holding the native splash (`Splash.holdUntil`)
If your first screen needs a quick token check or cached config before appearing, hold the OS splash screen cleanly (with a built-in safety timeout so a slow network never hangs startup):

```ts
import { Splash } from "@zeronative/core"

Splash.holdUntil(loadInitialSession(), { maxMs: 1500 })
```

### App-wide layers (`top` & `overlay`)
Pass named components imported from `.tsx` files (don't write JSX inside `main.ts`) to `startApp`:

```ts
// app/src/main.ts
import { installRuntime, startApp } from "@zeronative/core"
import { routes } from "./routes"
import { OfflineBanner } from "./OfflineBanner"
import { GlobalOverlay } from "./GlobalOverlay"

installRuntime()
startApp(routes, {
  top: OfflineBanner,
  overlay: GlobalOverlay,
})
```
