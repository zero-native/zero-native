# Data & Networking

`zero-native` includes production-hardened networking and storage out of the box — running on native I/O pools so the UI and JS threads stay fast.

---

## 1. Networking (`fetch`)

`fetch` is installed globally by `installRuntime()` and backed by **OkHttp 5** on Android and **URLSession** on iOS, running on a dedicated network thread.

```ts
import { effect, fetch, FetchError, setFetchDefaults, useAbortSignal } from "@zeronative/core"

// Optional app-wide defaults (call once at startup)
setFetchDefaults({
  timeout: 15_000,         // ms for the whole request (default 30_000; 0 = none)
  maxBodySize: 10_000_000, // bytes (default 10 MB)
})

// Inside a screen component: call useAbortSignal() in the component body
export function ProfileScreen() {
  const signal = useAbortSignal()

  effect(() => {
    void (async () => {
      try {
        const res = await fetch("https://api.example.com/profile", { signal })
        if (!res.ok) {
          showHttpError(res.status)
          return
        }
        const data = await res.json()
        setProfile(data)
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return // user left screen
        if (err instanceof FetchError) {
          // err.code: "offline" | "dns" | "connect" | "timeout" | "tls" | "connection_lost" | "too_large" | ...
          showNetworkError(err.code)
          return
        }
        throw err // don't swallow unexpected bugs
      }
    })()
  })
}
```

### Important production rules
- **Always check `res.ok`:** HTTP 4xx/5xx responses resolve normally (just like web `fetch`). Only transport failures reject with `FetchError`, and aborts reject with `AbortError`.
- **`fetch` is not tied to the screen:** Requests always settle even after a screen closes. Pass `useAbortSignal()` for read-only screen loads, and **omit it** for mutations/payments that must finish even if the user navigates away.
- **One-shot POSTs:** `fetch` does not retry POST requests automatically; use backend idempotency keys for sensitive mutations.
- **Cookies & HTTP cache are off** by default; response bodies are buffered completely (no `res.body` streaming).
- **Multipart uploads (`FormData`):** Pass files as `{ uri, name, type }` using a `content://` or `file://` URI (iOS: `file://` only). Native streams the file straight to the network without loading bytes into Hermes.
- **Progress & pool hygiene:** `onUploadProgress` / `onDownloadProgress` and automatic socket-pool flush on network switch are Android-only today. Check connectivity with `NetInfo` / `useNetInfo()`.

---

## 2. Real-Time Connections (`WebSocket`) — Android Only

> **Platform note:** `WebSocket` is currently **Android-only** (iOS `URLSessionWebSocketTask` support is planned).

Standard `WebSocket` is installed globally by `installRuntime()` (text frames, 1 MB message cap; `ws.close(code, reason)` accepts only `1000` or `3000–4999` with a reason of at most 123 UTF-8 bytes).

```ts
const ws = new WebSocket("wss://api.example.com/live")
ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe" }))
ws.onmessage = (e) => console.log("Received:", e.data)
ws.onerror = (e) => console.log("WS error:", e)
ws.onclose = (e) => console.log("Closed:", e.code, e.reason)
```

> **Tip:** Close open WebSockets when your app moves to the background (`onAppState`) to save battery on mobile networks.

---

## 3. Fast Key-Value Storage (`storage` & `persistedSignal`)

`storage` is backed by **MMKV** in the shared C++ core — **synchronous**, memory-mapped, and safe across app kills.

```ts
import { storage, createStorage, persistedSignal } from "@zeronative/core"

// Default app store (synchronous reads & writes)
storage.set("theme", "dark")
const theme = storage.getString("theme") // "dark" | undefined
storage.set("seenOnboarding", true)
storage.delete("tempKey")

// Reactive signal backed by storage
const currency = persistedSignal("currency", "INR")
currency.set("USD")

// Separate named store (id must match /^[A-Za-z0-9._-]{1,64}$/)
const cache = createStorage("api-cache")
cache.set("lastSync", Date.now())
cache.flush() // forces sync to flash so it survives a sudden power cut
```

- **Durability & security:** Every `set` survives an app kill immediately; call `flush()` after critical writes to survive a sudden power cut (~30 s window otherwise). A corrupted store opens empty, and stores are **not encrypted** — never store secrets or in-flight payment intents here.
- React Native's async `AsyncStorage` API is also exported from `@zeronative/core` (backed by its own separate MMKV store).

---

## 4. Secrets & Tokens (`SecureStore`)

Use `SecureStore` for auth tokens, refresh tokens, and sensitive keys (strings up to 64 KB). It encrypts values using **Android Keystore** (AES-GCM) and **iOS Keychain**. **Never store secrets in `storage` or `FlowStore`** (both are unencrypted files).

```ts
import { SecureStore } from "@zeronative/core"

await SecureStore.set("refreshToken", token)

try {
  const saved = await SecureStore.get("refreshToken")
  if (saved === null) {
    // Missing or permanently unreadable — prompt the user to sign in again
    nav.reset([{ name: "login" }])
    return
  }
  useToken(saved)
} catch (err) {
  if (SecureStore.isTemporary(err)) {
    // Keystore temporarily busy (e.g. older Android right after boot): value is kept!
    // Show a retry option — do NOT sign the user out.
    showRetryScreen()
    return
  }
  throw err
}
```

---

## 5. `FlowStore`: Crash-Safe Multi-Step Flows

When your app triggers a payment and opens an external app (like a UPI app), Android may kill your process in the background to reclaim RAM. **`FlowStore`** is a dedicated C++ **memory-mapped, two-slot atomic file** (`posix_fallocate`-reserved, up to 256 KB JSON per key) built for write-ahead state.

```ts
import { flowStore, Os } from "@zeronative/core"

const KEY = "pending-payment"
type PendingPayment =
  | { orderId: string; step: "paying" }
  | { orderId: string; paymentId: string; step: "in-upi" }

// Starting a payment
async function startPayment(orderId: string) {
  // 1. Check for an existing in-flight payment first — never overwrite it!
  const existing = flowStore.read<PendingPayment>(KEY)
  if (existing.status === "ok") {
    // "paying" here means this run is already starting a payment (a second tap while /pay is in flight):
    // ignore the tap. resumePendingPaymentOnStart() has already cleared any "paying" left from an earlier run.
    if (existing.value.step === "in-upi") openStatusAndVerify(existing.value.paymentId)
    return
  }
  if (existing.status === "broken") {
    blockAndCheckLatestPaymentFromServer()
    return
  }

  // 2. Write "paying" BEFORE calling /pay.
  //    A key's file and disk space are reserved on its first save, so a full disk can only fail here.
  if (!flowStore.write(KEY, { orderId, step: "paying" })) {
    showLowStorageError()
    return
  }

  // Your backend's /pay must be idempotent per orderId: a retry after a restart gets the same payment, not a new one.
  let paid: { paymentId: string; upiLink: string }
  try {
    paid = await api.pay(orderId)
  } catch {
    // The UPI app never opened, so no money moved: clear the record so the user can tap again.
    flowStore.remove(KEY)
    showError("Could not start the payment")
    return
  }
  const { paymentId, upiLink } = paid

  // 3. Write "in-upi" BEFORE launching the UPI app. Keep the record small (< 32 KB) so it fits in reserved space.
  //    Never launch the UPI app if write() returns false.
  if (!flowStore.write(KEY, { orderId, paymentId, step: "in-upi" })) {
    flowStore.remove(KEY) // the UPI app never opened: no money moved
    showError("Could not start the payment")
    return
  }

  // 4. Launch the external UPI app
  await Os.launchActivity({ action: "android.intent.action.VIEW", uri: upiLink }).catch(() => {})

  // 5. Never trust the UPI app's return value — always verify with your backend
  const status = await api.verify(paymentId)
  if (status === "pending") {
    openPendingScreenAndPoll(paymentId)
  } else {
    showFinalResult(status)
    flowStore.remove(KEY)
  }
}

// On app startup / restart: handle all 4 states cleanly
async function resumePendingPaymentOnStart() {
  const saved = flowStore.read<PendingPayment>(KEY)
  if (saved.status === "missing") return // nothing in flight

  if (saved.status === "broken") {
    // Both copies corrupted: ask the backend for the user's latest payment and block new payments until it answers
    blockAndCheckLatestPaymentFromServer()
    return
  }

  if (saved.value.step === "paying") {
    // Killed before /pay answered: the UPI app never opened, so no money moved. Clear and let the user retry.
    flowStore.remove(KEY)
    return
  }

  // step === "in-upi": open status screen and call /verify (poll if still pending).
  // NEVER reopen the UPI app and NEVER call /pay again after a restart!
  openStatusAndVerify(saved.value.paymentId)
}
```

### FlowStore rules to remember
- **Not a settings store:** Each key is its own ≥ 64 KB file; keep it to a few active flow records.
- **Not encrypted:** Never store secrets or tokens in `FlowStore`; use `SecureStore`.

---

## 6. Formatting Numbers, Currency & Dates (`Intl`)

Hermes includes `Intl` (`Intl.NumberFormat`, `Intl.DateTimeFormat`). `installRuntime()` caches `Number.prototype.toLocaleString` / `Date.prototype.toLocaleString` formatters so repeated currency and date formatting in lists stays fast. *(If you construct `new Intl.NumberFormat(...)` directly, reuse the instance outside list rows.)*
