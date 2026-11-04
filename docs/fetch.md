# `fetch`: design and the problems it must handle

Step 3.4 (**built 2026-10-30**; checked on the Lava, debug and release: 27 / 27 cases on the `/dev/fetch` screen,
see §6). The web `fetch` API for zero-native apps, built on OkHttp on Android (URLSession on iOS later).
This file lists the problems React Native and Flutter teams hit with HTTP in production, and what we do about each.
Sources: our own experience with OkHttp / RN, plus a research pass by agy (Gemini) on 2026-10-30. The GitHub issue
numbers agy gave were **not checked one by one**, so they are left out; the problems themselves are well known.

## 1. What app code gets
```ts
const res = await fetch("https://api.example.com/v1/offers?page=2", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ storeId }),
  signal,              // AbortController / AbortSignal.timeout(ms) / useAbortSignal()
  timeout: 30_000,     // zero-native extra: whole request limit in ms (default 30 s; 0 = no total limit, but
                       // still fails after 60 s without any data moving)
  maxBodySize: 10e6,   // zero-native extra: biggest response body in bytes (default 10 MB)
})
if (!res.ok) throw new Error(`offers: HTTP ${res.status}`)
const data = await res.json()
```
- Globals: `fetch`, `Headers`, `Request`, `Response`, `FormData`, `TextEncoder`, `TextDecoder`, and
  `AbortSignal.timeout / any / abort`.
- **Everything is configurable:** `timeout` and `maxBodySize` per request, or for the whole app with
  `setFetchDefaults({ timeout: 20_000, maxBodySize: 5e6 })` (from `@zero-native/core`, call once at startup). Tying a
  request to its screen is per request: `signal: useAbortSignal()`. Native settings (pinning, interceptors):
  `ZnFetch.configure` (§5).
- `Response`: `status`, `statusText`, `ok`, `url` (after redirects), `redirected`, `headers`, `type`, `bodyUsed`,
  `text()`, `json()`, `arrayBuffer()`, `bytes()`, `clone()`. `Response.json(data)` and `new Response(body, init)` for
  mocks in tests.
- Request bodies: `string`, `ArrayBuffer` / typed array / `DataView`, `URLSearchParams` (when the engine has it),
  `FormData` (text fields + files given as `{ uri, name, type }`). Anything else (a plain object) is a `TypeError`
  that says "use JSON.stringify" (the web would silently send `[object Object]`).
- `method` is upper-cased for the web's six methods **and PATCH** (the web leaves `"patch"` as is, which servers
  reject).
- Types: the global `fetch` is typed by TypeScript's DOM lib; `timeout` and `maxBodySize` are added to its
  `RequestInit`. For `FormData` files (`{ uri }`), import `FormData` from `@zero-native/core` to get the right type.
- Accepted but ignored (no meaning in an app): `mode`, `credentials`, `cache`, `referrer`, `referrerPolicy`,
  `integrity`, `keepalive`, `priority`.

## 2. How a call travels
1. JS checks the request (URL, method, headers, body) and sends one native call: the request head as JSON plus the
   body as **raw bytes** (no base64, no JSON escaping).
2. Kotlin builds an OkHttp request and runs it on OkHttp's own threads (`enqueue`). The JS thread and the UI thread
   never wait.
3. Kotlin reads the whole body (with the size limit) and answers once: head JSON + body bytes. C++ hands the bytes to
   JS as an `ArrayBuffer` without another copy.
4. `text()` / `json()` turn the bytes into a string in C++ (UTF-8, fast). `arrayBuffer()` copies only when called.

The body is read **before** the Promise resolves (not streamed). This is right for API calls (the 99 % case): one trip
to JS, and a cut-off body is always an error, never half a JSON. Big files need a native download (later, §7).

## 3. Problems and what we do

### Time and cancel
| Problem (seen in RN / Flutter) | What we do |
|---|---|
| RN `fetch` has **no timeout**: a silent server or a dead NAT mapping hangs the spinner forever | Default `timeout` 30 s for the **whole** request (connect + send + wait + download), timed by OkHttp in native (a busy JS thread can't delay it). One number, easy to reason about. `timeout: 0` turns it off. Connect alone is capped at 15 s. |
| Abort only rejected the JS Promise; the native request kept running and used data | `signal` aborts the OkHttp `Call` itself (socket closed). The Promise rejects with `signal.reason` (web rule), so `err.name === "AbortError"` / `"TimeoutError"` checks in libraries work. |
| "setState on an unmounted component" after leaving a screen | Not a problem here: writing to a signal of a closed screen does nothing. So `fetch` is **not** tied to the screen: it always settles, `finally` blocks always run, and a payment request is never cut off just because the user pressed back. For screen-only data, `useAbortSignal()` gives a signal that aborts when the screen closes. |
| Dev reload (Fast Refresh) while a request is in flight crashed RN (answer sent to a dead runtime) | `zn dev` reload cancels every running native call, including fetches. Answers carry the runtime generation they belong to; an answer for an old runtime is dropped. |

### Sending twice (payments)
| Problem | What we do |
|---|---|
| OkHttp's `retryOnConnectionFailure` (on by default) can **send a POST again** after the first one reached the server, when a reused connection breaks before the answer. Duplicate orders / payments. | Only `GET`, `HEAD`, `OPTIONS`, `PUT`, `DELETE` may be retried by OkHttp. For every other method the body is marked **one-shot**: OkHttp still tries another address if connecting fails (nothing was sent yet), but never sends the body a second time. Side effect: a `307` / `308` redirect of a POST is not followed; the app gets the 307 response. |
| App killed mid-request: did the server get it? | `fetch` can't know. Use the save-then-verify pattern (`docs/guide-notes.md` §16): save before calling, check with the server after a restart. `fetch` itself never retries anything. |
| Retries with back-off | Not inside `fetch` (the web doesn't either). Do it in app code, and only for GETs or requests with an `Idempotency-Key` header the server honours. |

### Redirects
| Problem | What we do |
|---|---|
| `Authorization` sent to another host after a redirect (token leak) | OkHttp drops `Authorization` when a redirect goes to another host. |
| HTTPS → HTTP redirect (downgrade) | Refused: the Promise rejects with code `insecure_redirect`. |
| POST turned into GET on 301 / 302 / 303 | Same as browsers (OkHttp follows the HTTP rules). `res.redirected` and `res.url` tell the app where it ended up. |
| App wants to see the redirect | `redirect: "manual"` returns the 3xx response; `redirect: "error"` rejects on any redirect. |

### Bodies, text and JSON
| Problem | What we do |
|---|---|
| Big JSON / downloads ran RN out of memory on 2–3 GB phones (body copied 3–4 times, base64) | Bytes cross as an `ArrayBuffer` (no base64, no JSON escaping). Response bodies over `maxBodySize` (10 MB default) are refused: early from `Content-Length`, or while reading. |
| UTF-8 BOM at the start of the body breaks `JSON.parse` | `text()` / `json()` strip the BOM (the web's UTF-8 decode does the same). |
| Bad UTF-8 bytes | Turned into `U+FFFD` (web rule), never a crash. |
| Server says `charset=ISO-8859-1` | `text()` always decodes UTF-8, like the web. For other encodings use `arrayBuffer()` and decode yourself. |
| `res.json()` on a 204 / empty body throws "Unexpected end of JSON input" | Still throws (web rule; hiding it would hide bugs), but with a clear message: `Response from https://host/path (status 204) has an empty body; it isn't JSON`. |
| HTML instead of JSON (captive portal on hotel Wi-Fi, proxy error page, 502 from the load balancer) gives the useless "Unexpected token <" | `json()` errors say the URL (without the query string, which can hold tokens), the status and the content type, and, when the body clearly isn't JSON (doesn't start with `{` or `[`), its first 60 characters. Broken JSON is never quoted (it is the app's data). |
| JSON parsing big bodies blocks the JS thread | Our UI runs on its own thread, so scrolling never stutters; only JS work waits. Keep API responses small (paginate). |
| `gzip`: setting `Accept-Encoding` yourself turns off OkHttp's automatic unzip, so the app gets zipped bytes | `Accept-Encoding` is set only by the network stack (it is a "forbidden header" on the web too); an app value is dropped with a warning in debug builds. |
| `Content-Length` wrong after unzip / body cut short | OkHttp removes `Content-Length` when it unzips; a body shorter than promised is a `network` error, never a short body. |
| GET / HEAD with a body crashes OkHttp; POST without a body crashes OkHttp ("method POST must have a request body") | GET / HEAD with a body: `TypeError` in JS (web rule). POST / PUT / PATCH without a body: sent with an empty body. |
| Forgot `Content-Type: application/json` | Default for a string body is `text/plain;charset=UTF-8` (web rule). A warning is logged (once) when the string looks like JSON and no content type was given. |

### Headers
| Problem | What we do |
|---|---|
| Header name case (`content-type` vs `Content-Type`) | `Headers` is case-insensitive (web `Headers`). |
| Several `Set-Cookie` headers merged with commas (dates contain commas) | Headers cross as a list of pairs; `headers.getSetCookie()` returns them one by one. |
| Non-ASCII header value crashes OkHttp ("Unexpected char 0x…") | `Headers` throws a clear `TypeError` in JS when a value has a character above `~` or a line break; encode such values (`encodeURIComponent`). |
| Default `User-Agent: okhttp/4.x` is blocked by some firewalls (bot rules) | Default `User-Agent`: `<app label>/<versionName> (Android <release>) zero-native/<version>`. Apps can set their own. No device model (it helps fingerprinting). |
| Transport headers set by hand (`Host`, `Connection`, `Content-Length`, `Transfer-Encoding`, …) break requests | Dropped, with a warning logged once per header. `Cookie`, `Origin`, `Referer`, `User-Agent` are allowed (apps use them). |
| `FormData` with a hand-written `Content-Type: multipart/form-data` loses the boundary → "Missing boundary" | For a `FormData` body, a hand-written `Content-Type` is replaced by the one with the boundary. |

### Network
| Problem | What we do |
|---|---|
| All errors look the same ("Network request failed") | `FetchError` (a `TypeError`) with `code`: `offline`, `dns`, `connect`, `timeout`, `tls`, `cleartext_blocked`, `connection_lost`, `insecure_redirect`, `redirect_not_allowed`, `too_many_redirects`, `too_large`, `invalid_request`, `failed`. The message keeps the native reason and `METHOD url` without the query string. |
| Wi-Fi ↔ mobile switch: pooled connections are dead, the next requests hang until timeout | Kotlin listens for default-network changes and closes all pooled connections. |
| Mobile carriers drop idle NAT mappings after 30–60 s; reused connections black-hole | Idle connections are kept for 30 s (OkHttp default: 5 min). |
| OkHttp queues the 6th request to one host (limit 5) | Limit raised to 10 per host, 64 in total. |
| Cleartext `http://` blocked on Android 9+ ("CLEARTEXT communication … not permitted") | Error code `cleartext_blocked` with a message that says to use HTTPS or allow the host in the app's network security config. The sample allows only `localhost` (for the test server via `adb reverse`). |
| Captive portals / "connected but no internet" | Not detected by `fetch` (needs a network-status module, later). The `json()` error message above makes the HTML case clear. |
| Proxies / VPN / Charles | OkHttp uses the system proxy. User-installed CA certificates (Charles) work only if the app's network security config trusts them in debug builds. |
| Cookies (RN's shared cookie jar surprised people; WebView sync) | **Off** (ARCHITECTURE §14). `Set-Cookie` is readable; apps send tokens in headers. |
| HTTP cache | Off. `cache` option ignored. Use `ETag` / `If-None-Match` by hand if needed. |
| Background: Android freezes / dozes background apps, requests die | Requests keep running while the process runs, but nothing promises they finish in the background. Uploads that must finish need WorkManager (later). |

### Debug help
- Debug builds log one line per request: `fetch POST https://host/path → 200 in 182 ms (4.1 KB)`. No query string, no
  headers, no bodies (tokens and personal data). Release builds log nothing.

## 4. How it is built (for framework work)
- **Bytes across the bridge** (new, usable by any native module): `callNative(..., { bytes })` passes an
  ArrayBuffer / typed array to native as `call.bytes` (`__zn_call` got an optional buffer range). Native answers with
  `call.resolveBytes(value, bytes)`; that goes as app event 9, one ArrayBuffer `[u32 LE head size][head JSON][body]`
  made in C++ without another copy (`Engine::callGlobalBytes`, `jsi::ArrayBuffer` over a `MutableBuffer`). JS gets
  `{ value, bytes }`, `bytes` being a Uint8Array view.
- **UTF-8 in C++:** `core/src/utf8.cpp` (WHATWG rules, tested in the core tests); host functions `__zn_utf8Decode`
  (bad bytes → U+FFFD, or `undefined` when fatal) and `__zn_utf8Encode`. `TextEncoder` / `TextDecoder` (UTF-8 only)
  are installed on them when Hermes has none.
- **Answers after a dev reload:** every native call answer carries the runtime generation it was asked in; an answer
  for a replaced runtime is dropped on the JS thread (`ZnRuntime.dispatchAnswer`).
- Files: `packages/core/src/{fetch,headers,formdata,text,abort,calls}.ts`, `android/runtime/.../ZnFetch.kt`,
  `ZnModules.kt`, `jni_bridge.cpp`, `core/src/hermes_engine.cpp`.

## 5. Native setup for apps (Kotlin)
`ZnFetch.configure { builder -> ... }` (before `ZnRuntime.start`) lets the app change the shared `OkHttpClient`:
certificate pinning, an extra trusted root, interceptors (Chucker in debug), a proxy. Rules:
- **Pinning can't be fixed by OTA.** Pins live in native code. Pin the intermediate / root CA keys and always add a
  backup pin, or a certificate change on the server locks every old app out.
- Don't turn `retryOnConnectionFailure` back on for POSTs, and don't add retry interceptors for non-idempotent
  methods.

### For plugin authors: `ZnFetch.addClientSetup` (2026-11-04)
`ZnFetch.addClientSetup { builder -> ... }` lets a **plugin** change the shared client too (the Performance plugin adds
an interceptor this way).
- It runs **after** the app's own `ZnFetch.configure`, in the order plugins were added. So the app's pins and
  interceptors are already there.
- Call it before the first fetch (as `configure`). After that it does nothing and answers `false`.
- **Known limit:** the plugin gets the **whole** `OkHttpClient.Builder`, not only a way to add an interceptor. A plugin
  can change or undo the app's settings (pins, timeouts, retries). Only use plugins you trust. A fix is planned: allow
  only adding interceptors.
- Interceptors added this way also see the OTA check and download requests, because those use `ZnFetch.client`.

## 6. Checked on the phone
`/dev/fetch` in the sample runs 27 cases against `tools/fetch-test-server.ts` (through `adb reverse`) and a few public
HTTPS hosts. Lava Blaze 2 5G, Android 14, Wi-Fi, 2026-10-30, debug and release (R8): **27 / 27 pass**. Highlights:
- **POST never sent twice:** the test server keeps a pooled connection and kills it after a request arrives. OkHttp
  sent the **PUT twice** (its normal retry) and the **POST once** (our one-shot guard). This is the duplicate-payment
  bug, shown and stopped.
- `timeout: 1500` on a 4 s answer → `timeout` after 1508–1516 ms; `AbortSignal.timeout(800)` → `TimeoutError` at
  ~805 ms.
- 5 MB body in ~450 ms (Wi-Fi + adb reverse); 2 MB with `maxBodySize: 1e6` → `too_large` before reading it all.
- A body cut short (`Content-Length: 1000`, 10 bytes sent) → `connection_lost`, never a short body.
- Real HTTPS (`generate_204`) ~200 ms; `expired.badssl.com` → `tls`; `http://example.com` → `cleartext_blocked`;
  `httpbin.org` HTTPS → HTTP redirect → `insecure_redirect`; `.invalid` host → `dns`.
- Debug log: `fetch GET http://localhost:8788/json → 200 in 18 ms (69 B)`; nothing in release.
- Not checked yet: switching Wi-Fi ↔ mobile mid-use (pool eviction), airplane mode (`offline`), a real `content://`
  file upload, 2G-like slow networks.

## 7. Not in this step (later)
| Item | Why later |
|---|---|
| Streaming bodies (`res.body` reader, server-sent events) | Not needed for APIs. `res.body` is `null` today. |
| Upload / download progress events | Needs throttled events; first real use is uploads. |
| Download to a file (big files without JS memory) | Native `download(url, path)`. |
| `Blob`, `File`, byte parts in `FormData` | Hermes has no `Blob`; files go as `{ uri }`. |
| Cookie jar, HTTP cache | Off on purpose; add only if an app needs it. |
| Happy Eyeballs (`fastFallback`: try IPv6 and IPv4 together) | **Done 2026-10-30:** OkHttp 5.5.1, `fastFallback(true)` set in `ZnFetch`. Not tested on a network with broken IPv6. |
| Let's Encrypt on Android 7.0 (API 24) | Android 7.0 doesn't trust ISRG Root X1. An app that needs it adds the root through `ZnFetch.configure`. Not needed for ZeroBill (Pavan, 2026-10-30: our servers don't use Let's Encrypt). |
| Share the OkHttp client with Coil (images): one pool, one config (pinning applies to images too) | One connection pool for API + images; touches image loading, so its own small step. |
| Network status (`online`, Wi-Fi / mobile, validated) | Small module (milestone 3.7 list). |
| iOS (URLSession) | With the iOS renderer. |
