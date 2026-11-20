# Core Concepts

If you learn one thing about `zero-native`, make it this:

> **A component function runs once — when it mounts. It never re-renders.**

When state changes, `zero-native` does **not** re-run your component function or diff a virtual DOM. Instead, the compiler turns every reactive JSX expression into a direct link from a **signal** to a **native UI slot**. Change a signal, and only that exact leaf `<Text>` or style property updates on the UI thread.

---

## 1. Signals

Signals are the reactive primitives from `@zeronative/core`:

```ts
import { signal, computed, effect, batch, untrack } from "@zeronative/core"

const price = signal(100)
const discount = signal(20)

// Derived value: recalculates automatically when price or discount changes
const total = computed(() => Math.max(0, price() - discount()))

// Side effect: runs immediately, then whenever `total` changes
effect(() => {
  console.log("Total is now:", total())
})

// Update multiple signals in a single UI batch
batch(() => {
  price.set(150)
  discount.set(30)
})

// Read without subscribing the current effect/computed
const snapshot = untrack(() => price())
```

### Key rules for signals
- **Read with `s()`, write with `s.set(next)`.**
- **Equal writes are no-ops.** `s.set(next)` checks `Object.is(prev, next)`. Writing the same value does not trigger effects or send a native patch. You can pass a custom `equals` function for objects.
- **Persistent variants:**
  - `persistedSignal(key, initial)` — automatically saved in synchronous `storage` (MMKV); survives app restarts and updates.
  - `restorableSignal(key, initial)` — scoped to a screen; restored automatically if the OS kills your app in the background (e.g., while the user is in another app), and cleared when the user leaves the screen normally.

---

## 2. How Reactivity Works in JSX

The compiler automatically wraps dynamic JSX expressions so you don't have to write `() =>` wrappers by hand:

```tsx
export function Counter() {
  const count = signal(0)

  // ✅ GOOD: reactive expression inside JSX — compiler turns this into a slot
  return <Text>Count: {count()}</Text>
}
```

### The #1 mistake for React developers: reading a signal in the component body

Because the component function **runs only once**, computing a derived value as a plain variable in the component body and showing it in JSX would stay frozen at its initial value — so the compiler catches this and **fails the build** with a clear error:

```tsx
// ❌ BUILD ERROR: `doubled` reads `count()` once in the body instead of reactively
export function BrokenCounter() {
  const count = signal(0)
  const doubled = count() * 2
  return <Text>{doubled}</Text>
}

// ✅ GOOD: use `computed(...)` or compute directly inside JSX
export function WorkingCounter() {
  const count = signal(0)
  const doubled = computed(() => count() * 2)
  return <Text>{doubled()}</Text>
}
```

### Props stay reactive
The compiler passes component props as lazy getters so child components stay reactive when parent signals change:

```tsx
// ✅ Both work and stay reactive:
function PriceTag(props: { amount: number }) {
  return <Text>₹{props.amount}</Text>
}
function PriceTagShort({ amount }: { amount: number }) {
  return <Text>₹{amount}</Text>
}
```

Simple top-level destructuring (including defaults) is rewritten by the compiler to keep reactivity. Rest patterns (`...rest`), nested/array destructuring, and reassigning destructured params are build errors.

---

## 3. Control Flow in JSX

You don't need special `<If>` or `<For>` components — plain JavaScript expressions work, and the compiler turns each into a native anchor with its own compiled sub-template:

### Conditionals (`&&` and `? :`)
```tsx
<Column>
  {isLoading() && <Spinner />}
  {error() ? <Text style={s.err}>{error()}</Text> : <Text>All good!</Text>}
</Column>
```

> **Important:** When `cond` flips from `true` to `false`, the branch is unmounted **before** its inner expressions re-evaluate — so `{user() && <Text>{user()!.name}</Text>}` is completely safe and won't crash with a null dereference.

### Short lists (`.map`)
For small lists (up to ~100 items) inside a `Column`, `Row`, or `Scroll`:

```tsx
<Column gap={8}>
  {items().map((item) => (
    <Row key={item.id}>
      <Text>{item.title}</Text>
    </Row>
  ))}
</Column>
```

- Every `.map` row **must** have a unique, stable `key`.
- For long or infinite lists (hundreds or thousands of rows), always use the virtualized `<List>` component (see [Components](components.md#5-virtualized-lists)).

### Fragments & Children
- Fragments (`<>...</>`) work anywhere, except as the root of a `.map` or `<List>` row (a row must have a single root element for its key).
- Passing children (`<Card><Text>Hi</Text></Card>`) or JSX props (`header={<Title />}`) works — render them with `{props.children}` or `{props.header}`. Inspecting, counting, or mapping over `props.children` is not supported.

### Early returns
Simple top-level early returns (`if (loading()) return <Spinner />`) are supported in screens and child components — the compiler rewrites them into reactive branches. Early returns inside loops, `try`/`catch`, or `switch` fail the build; use `? :` or `&&` in JSX for complex branching.

---

## 4. Event Handlers & Taps

- **Taps live on `<Pressable>` (and RN aliases `TouchableOpacity`, `TouchableHighlight`, `TouchableWithoutFeedback`), plus `<Text onPress>` for links.**
- Layout containers (`Column`, `Row`, `Stack`, `View`) do **not** accept `onPress`. Wrap them in a `<Pressable>` instead — this guarantees proper accessibility roles and native press feedback.
- **Press lifecycle:** `onPressOut(cancelled)` *always* fires once after `onPressIn`, even if a scroll gesture cancels the touch (`cancelled === true`).
- **Press-and-hold repeat is native:** Use `onPressRepeat` with `repeatDelay` (default 400 ms) and `repeatInterval` (default 100 ms) instead of JS timers — eliminating "zombie timer" bugs when fingers slide off buttons.
- **Handlers created by helper calls:** If you write a guard helper (such as a user-defined `once(submitPayment)`), the compiler evaluates `once(submitPayment)` **once** when the element mounts (not on every tap), so single-fire guards work safely without risk of double-firing.

---

## 5. Lifetimes, Cleanup & Timers

Every screen, conditional branch, and list row runs inside a reactive **owner scope**:

- **`onCleanup(fn)`** runs automatically when the enclosing screen, branch, or row unmounts.
- **Timers (`setTimeout`, `setInterval`, `requestAnimationFrame`)** created inside a screen or component are automatically owned by that scope and cleared when the screen closes — no leaked timers!
- **`useAbortSignal()`** returns an `AbortSignal` that aborts automatically when the screen unmounts — pass it to `fetch(url, { signal })` to cancel in-flight requests cleanly.
- **`detached(fn)`** runs code outside the current screen's scope (for app-wide work that must survive navigating away, such as finishing a payment verification loop).

```tsx
import { effect, onCleanup, useAbortSignal } from "@zeronative/core"

export function ProfileScreen(props: { userId: string }) {
  const abort = useAbortSignal()

  effect(() => {
    const id = setInterval(() => refreshStatus(), 10_000)
    onCleanup(() => clearInterval(id))
  })
  // `abort` is also aborted automatically if the user leaves this screen
}
```

---

## 6. Error Handling & Resilience

- **Screen error boundaries:** If a screen throws during mount or an event, `zero-native` catches it, keeps the rest of the app alive, and displays a recovery screen (with **Try again** / **Go back**).
- **JS hang protection:** The engine enforces a per-tick execution time limit (3 s in debug, 2 s in release) so an accidental infinite loop never permanently freezes the app.
- **Global error hook:** Register `onError((error, info) => ...)` to log JS errors and unhandled promise rejections to Crashlytics or your own backend.

---

## 7. Performance Habits

1. **Keep module top-levels light.** Don't do heavy work or disk I/O at import time — cold start runs your entry module before the first JS batch.
2. **Use `<List>` for long data, `.map` for short lists.** `<List>` only mounts rows near the viewport.
3. **Prefer `animate` and UI-thread motion values over `setInterval` animations.** JS should send target values, never 60 fps frames.
4. **Use `batch()`** when updating several related signals at once.
5. **Measure on release builds** on a real low-end phone — debug builds include Compose and Hermes overhead that disappears in release.
