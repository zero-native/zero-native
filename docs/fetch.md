# `fetch`: design and the problems it must handle

Step 3.4 (**built 2026-10-30**; checked on the Lava, debug and release: 27 / 27 cases on the `/dev/fetch` screen,
see §6). The web `fetch` API for zero-native apps, built on OkHttp on Android and URLSession on iOS (§9).
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
  onUploadProgress: ({ loaded, total }) => { /* ... */ },   // zero-native extra: throttled to ≥ 100 ms
  onDownloadProgress: ({ loaded, total }) => { /* ... */ }, // zero-native extra: total = -1 when unknown
})
if (!res.ok) throw new Error(`offers: HTTP ${res.status}`)
const data = await res.json()
```
- Globals: `fetch`, `Headers`, `Request`, `Response`, `FormData`, `TextEncoder`, `TextDecoder`, and
  `AbortSignal.timeout / any / abort`.
- **Everything is configurable:** `timeout` and `maxBodySize` per request, or for the whole app with
  `setFetchDefaults({ timeout: 20_000, maxBodySize: 5e6 })` (from `@zeronative/core`, call once at startup). Tying a
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
  `RequestInit`. For `FormData` files (`{ uri }`), import `FormData` from `@zeronative/core` to get the right type.
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

### Progress events (`onUploadProgress`, `onDownloadProgress`)
- At most one event per 100 ms, plus a last event with the final count. `total` is `-1` when the size is not known
  (a streamed `content://` file, a download without `Content-Length`).
- The last upload event is the bytes really written and the same `total` as the others: `{ loaded: 16484,
  total: -1 }` for a body of unknown size, never `{ loaded: -1, total: -1 }` (fixed 2026-11-08).
- **Upload progress can count again from 0.** OkHttp writes the body once per try. If OkHttp sends the request again
  (a GET / PUT / DELETE retried after a dead connection; POST and PATCH are one-shot and never sent twice), or an
  interceptor reads the body before it is sent (a logging interceptor such as Chucker), `loaded` starts again from 0.
  Show progress as "about this far", not as proof of what the server got.
- Progress ids start at a random number in each JS runtime, so after a dev reload or an OTA restart a late event
  of an old request never reaches a new one.
- **iOS** counts the same way (URLSession's `didSendBodyData` and the bytes received). URLSession may also send a body
  again on a new connection, so "can count again from 0" holds there too. A `FormData` body's `total` is its full
  length on iOS (it is staged in a file first, §9); on Android it is `-1` when a `content://` file's size can't be read.

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
| Wi-Fi ↔ mobile switch: pooled connections are dead, the next requests hang until timeout | Kotlin listens for default-network changes: new calls get a new client with an empty pool (`ZnFetch.client` changes; `ZnFetch.derived` for clients with other settings), and the old pool's idle connections are closed. Closing alone wasn't enough: an HTTP/2 connection still in use kept taking new calls (review 2026-11-09). Images use the same client. iOS: the same with a new URLSession (§9); images there are not covered. |
| Mobile carriers drop idle NAT mappings after 30–60 s; reused connections black-hole | Idle connections are kept for 30 s (OkHttp default: 5 min). |
| A connection in use dies silently (no close, no error; seen in ZeroBill PAY-5, a start in the background from a UPI result): every later call is queued on it and times out, for minutes, with no network change to clear it | An HTTP/2 connection is pinged every 10 s (`pingInterval`); with no answer by the next ping it is dropped with its calls, and the next call opens a new one. A GET is retried by OkHttp; a POST fails as `connection_lost`. Not closed on a timeout: that would also end healthy calls sharing the connection (a payment POST with an unknown result). Since 2026-11-07. |
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

### For plugin authors: `ZnFetch.addInterceptor` (2026-11-04)
`ZnFetch.addInterceptor(interceptor)` lets a **plugin** add an OkHttp interceptor to the shared client (the Performance
plugin adds its network traces this way).
- It is added **after** the app's own `ZnFetch.configure` and its interceptors, in the order plugins were added.
- A plugin gets **no builder**, so it can't change or undo the app's settings (pins, redirects, retries, timeouts).
  This replaced `addClientSetup { builder -> }`, which gave the whole builder (second-opinions 105).
- Call it before the first fetch (as `configure`). After that it does nothing and answers `false`.
- If the interceptor throws a runtime error, that fetch fails with `connection_lost` and the app keeps running. Without
  this guard, OkHttp throws the error again on its own thread, which crashes the app. The request is **not** sent
  again, because the error may come after it reached the server.
- Interceptors added this way also see the OTA check and download requests, because those use `ZnFetch.client`.
- **Later, a Cronet transport:** Cronet's OkHttp bridge (`CronetInterceptor`) is also an interceptor, so it fits. It
  must be the last interceptor, so its plugin must be registered last.

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
| Upload / download progress events | **Done 2026-11-08:** `onUploadProgress` and `onDownloadProgress` in `FetchInit`, throttled to ≥ 100 ms with the final count guaranteed. |
| Download to a file (big files without JS memory) | Native `download(url, path)`. |
| `Blob`, `File`, byte parts in `FormData` | Hermes has no `Blob`; files go as `{ uri }` (`content://` or `file://` on Android, `file://` on iOS). |
| Cookie jar, HTTP cache | Off on purpose; add only if an app needs it. |
| Happy Eyeballs (`fastFallback`: try IPv6 and IPv4 together) | **Done 2026-10-30:** OkHttp 5.5.1, `fastFallback(true)` set in `ZnFetch`. Not tested on a network with broken IPv6. |
| Let's Encrypt on Android 7.0 (API 24) | Android 7.0 doesn't trust ISRG Root X1. An app that needs it adds the root through `ZnFetch.configure`. Not needed for ZeroBill (Pavan, 2026-10-30: our servers don't use Let's Encrypt). |
| Share the OkHttp client with Coil (images): one pool, one config (pinning applies to images too) | One connection pool for API + images; touches image loading, so its own small step. |
| Network status (`online`, Wi-Fi / mobile, validated) | Small module (milestone 3.7 list). |
| iOS (URLSession) | **Done** with the iOS renderer; progress, streamed `FormData` files and the network-change flush since 2026-11-21 (§9). |

## 8. `WebSocket` (shares the fetch client)
The browser `WebSocket` (`packages/core/src/websocket.ts`, native `ZnWebSocket.kt`) is built on the same shared
OkHttp client as `fetch`, so it gets the same pins, interceptors, proxy and connect timeout. Fixed after review
(2026-11-08): call order, the server's close, stale sockets after a reload, binary frames, the User-Agent.

What app code should know:
- **Pings every 10 s.** The shared client pings (`pingInterval`, the PAY-5 fix in §3 Network) every open socket
  every 10 s. With no answer by the next ping the socket fails: `error`, then `close` with code 1006. This finds dead
  sockets fast, but it also wakes the radio every 10 s while a socket is open, in the background too, which costs
  battery. Close sockets when the screen or the app goes to the background, and open them again on return.
- **User-Agent:** the handshake sends the same User-Agent as `fetch`
  (`<app label>/<versionName> (Android <release>) zero-native/<version>`), not `okhttp/...`.
- **Text frames only (v1).** `send()` takes a string; anything else is a `TypeError`. The first binary frame from
  the server gives one `error` event, then we close with 1003 ("Unsupported Data").
- **1 MB per message, in UTF-8 bytes.** `send()` of more throws a `RangeError` (counted in UTF-8 bytes, like native,
  not `.length`). An incoming message over 1 MB gives one `error`, then we close with 1009. **The cap protects JS, not
  native memory:** OkHttp 5.5.1 has no setting to limit an incoming message, and reads the whole message (after
  unzipping, with `permessage-deflate`) into memory before we can check its size. Only talk to servers you trust.
- **Server close:** we answer the server's close frame at once, so `close` comes with the server's code and
  `wasClean: true`. If our own close gets no answer, OkHttp cuts the socket after 60 s (`close` 1006).
- `close()` while CONNECTING cancels the connect: `error`, then `close` 1006 (browser rule).
- `send()` in CLOSING / CLOSED does nothing (no throw, like browsers; browsers add the size to `bufferedAmount`,
  which stays 0 here).

How it is built: `connect`, `send` and `close` run on the main thread only to keep the order JS called them in; each
is handed to one `zn-websocket` worker thread, which builds the client the first time (never on the main thread). Each
listener callback first checks that its socket is still the live one, so events of a socket dropped by a JS reset are
ignored. Socket ids start at a random number in each JS runtime. A JS reset cancels all sockets (no close handshake).

**iOS** (`ios/ZnRuntime/Swift/ZnWebSocket.swift`, on our own RFC 6455 client over `NWConnection`:
`ZnWebSocketConnection.swift` and `ZnWebSocketWire.swift`, tested on the Mac with `bun run tools/ios-unit-test.ts
websocket`): the same calls, events, limits and order, on one serial `zn-websocket` queue. Not
`URLSessionWebSocketTask` (used until 2026-11-27): when the server's 101, its first messages, its close and the TCP
FIN reach the phone in one read (a server that closes in its open handler, on Wi-Fi), URLSession drops everything
after the 101 and fails with ENODATA ("No message available on STREAM"), so JS got `close` 1006 instead of the
server's code and none of the messages (Pavan's iPhone 11 on iOS 18.7.8; on the Mac, the test server's
`/ws-closenow`, which sends all of it in one TCP segment, was lost in 10 of 10 runs; the iOS 26.3 simulator too).
Ours hands every read to the frame reader before it looks at the end of the stream. Differences:
- No proxy, pins or interceptors (iOS fetch has none either). TLS (`wss://`) is the system's, with its usual trust
  checks.
- Pings are our own 10 s timer; no pong by the next ping gives the same `error` + `close` 1006. The timer does not
  run while iOS suspends the app; it runs again on return. A ping that was waiting for its pong when the app was
  suspended is not counted as lost on return: a fresh ping gets the full 10 s (fixed 2026-11-21).
- **In the background the app answers nothing.** Android keeps answering the server's pings while the app is in the
  background; a suspended iOS app does not, so a server with its own ping timeout (Socket.IO about 20–25 s, AWS API
  Gateway and others) may close a socket the app leaves open in the background, and JS gets that `close` on return.
  Close sockets when the app goes to the background (as the battery note above says) and open them again on return.
- **Connect limit:** the 15 s also covers TLS and waiting for the server's 101 (our own timer). A server that sends
  its 101 after 20 s gives `error` + `close` 1006 "The request timed out." at 15 s. Android's 15 s covers only the
  TCP connect and then waits for the 101 without a limit.
- **A message over 1 MB is never kept:** its frame header says its size, so we give `error` and close with 1009 at
  once and skip its bytes as they come (OkHttp reads the whole message first).
- `ws://` follows the app's App Transport Security rules, checked by us (ATS does not check our connections, nor did
  it check WebSocket tasks): allowed to IP addresses, names with no dot and `.local` names, else only with
  `NSAllowsArbitraryLoads` or an `NSExceptionDomains` entry with `NSExceptionAllowsInsecureHTTPLoads`. Refused:
  `error` + `close` 1006 that names ATS (Android: the cleartext policy).
  As in ATS, `NSAllowsArbitraryLoads` counts only when none of `NSAllowsLocalNetworking`,
  `NSAllowsArbitraryLoadsInWebContent` and `NSAllowsArbitraryLoadsForMedia` is set.
- A handshake that gets no 101 says so like OkHttp, with the server's reason phrase:
  `Expected HTTP 101 response but was '404 Not Found'`. A server that picks a protocol we didn't offer, or uses an
  extension (we offer none), fails the socket (RFC 6455 §4.1).
- Many sockets to one host: no limit (80 at once seen). Android has none either.
Checks: sample screen `/dev/websocket` (route `wsLab`, 30 cases) against `tools/fetch-test-server.ts`. The cases where
the platforms differ (no 101 for 20 s) check each platform's own behaviour. `{ only: "one packet", repeat: 10 }` runs
the one-segment case ten times. On Android its unknown-host case is `wss://` and its cleartext case matches
`CLEARTEXT`.

## 9. iOS (`ios/ZnRuntime/Swift/ZnFetch.swift`, on URLSession)
The same call, answer, error codes, limits and events as Android. The plain rules are in `ZnNetRules.swift`, tested on
the Mac (`bun run tools/ios-unit-test.ts net`, Android's ProgressThrottler cases and OkHttp's multipart layout).
- **Progress:** as §3 "Progress events": at most one event per 100 ms plus the final count, `total` -1 when unknown
  (no `Content-Length`, or a gzip / br answer that URLSession unzips: the declared length is of the zipped body, and
  OkHttp drops it too). An empty body gives one upload event `0 / 0`; a GET none. No events after an abort or an error.
- **`FormData` files are streamed from disk.** The whole body is first written to a file in
  `Library/Caches/zn-fetch-upload` (file parts copied 256 KB at a time) and uploaded from that file, so a 200 MB video
  never enters memory (checked: the sample's peak footprint stayed at 48 MB through a 200 MB upload). URLSession then
  knows the length, so `Content-Length` is sent and upload progress has a `total`. The file is removed when the call
  ends (also on an abort), and files left by a killed run are removed at the next start.
  - `timeout` counts writing that file too (as OkHttp's call timeout counts writing the body): a call whose time runs
    out while the body is written rejects `timeout`, and the upload gets what is left.
  - The cost: free disk space as big as the body. A full disk rejects with `failed` ("not enough free space").
  - The layout is OkHttp's (what Android sends): each part has `Content-Length`; `"`, CR and LF in a name or file name
    are sent as `%22`, `%0D`, `%0A` (a file name can't add headers); a `type` that is not a valid media type is left out.
  - Only `file://` URIs. `content://` is an Android ContentProvider URI with no meaning on iOS: it rejects
    `invalid_request` ("content:// is an Android content URI; on iOS pass the file:// uri the plugin gave"). iOS plugins
    hand out `file://` URIs. A file that can't be read (missing, a folder) rejects `invalid_request` with its path. A
    symlink is followed. (Android sends a missing file without a length and fails during the call instead.)
  - A security-scoped file URL (from the document picker) is opened with its scope, so it can be passed as it is.
- **Network change:** an `NWPathMonitor` keys the network by the first interface of a working path that is not a
  tunnel (a VPN's `utun` is skipped, so Wi-Fi ↔ cellular under a VPN is still a change) and its IPv4 gateways (another
  Wi-Fi keeps `en0` but gets another router), or its IPv6 gateways when it has none (an IPv6 router advertisement
  arriving later on the same Wi-Fi is not a change). As Android's default-network callback: a lost network flushes,
  another network flushes, and a network coming back after none doesn't (the loss already flushed). Then
  new calls get a new URLSession, so no pooled connection of the old network is used; calls already running finish on
  the old session, which then ends (`finishTasksAndInvalidate`). Logged: `fetch: the default network changed: new calls
  use new connections`; debug builds also print each key change (`zn fetch network: <old> → <new>`). Debug builds have `Fetch.debugFreshSession` for the lab (a simulator can't change networks).
- **Not on iOS:** no HTTP/2 ping (URLSession has no setting; Android pings every 10 s), so a connection that dies
  silently without a network change is found only by the call's timeout. No `configure` / interceptors / pins.
  Pictures (`ZnImage.swift`) use `URLSession.shared`, which the network-change flush doesn't replace.

Checks: `/dev/fetch` (route `fetch`, 41 cases, params `port`, `dir`, `run`, `only`) against
`tools/fetch-test-server.ts --files <folder>`: **41 / 41 on the iOS simulator** (2026-11-21), among them upload and
download progress, a 3 MB and a 200 MB streamed file part checked byte for byte by the server, an abort during the
200 MB upload, a 50 ms timeout that runs out while the 200 MB body is written, the escaped file name, `content://` and a missing file, and the network-change case (4 calls running
across a flush all finish, the 4 calls after it each use a new connection). Not checked yet: a real Wi-Fi ↔ cellular
switch on an iPhone, the new cases on Android. The Mac suite (`bun run tools/ios-unit-test.ts net`) also keys this
Mac's real path and walks the flush rule through lost / back / changed networks.
