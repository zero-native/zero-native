// The web `fetch` for zero-native apps (docs/fetch.md): `fetch`, `Request`, `Response`, `FetchError`.
// Native side: android/runtime/.../ZnFetch.kt (OkHttp). The request head goes as JSON, the body as raw bytes; the
// answer comes back as one ArrayBuffer (calls.ts, app event 9), so nothing is base64'd or JSON-escaped.
//
// Rules worth knowing (all explained in docs/fetch.md):
// - Not tied to the screen: a fetch always settles, even after its screen closed. Use `useAbortSignal()` (abort.ts)
//   for requests only the screen needs.
// - `timeout` (default 30 s) limits the whole request; `maxBodySize` (default 10 MB) the response body. Both can
//   be set per request, or for the whole app with setFetchDefaults().
// - HTTP errors are not exceptions (`res.ok` is false). Network problems reject with a FetchError that has a `code`.
// - The body is read completely before the Promise resolves; `res.body` (streams) is not supported.
import { callNative, NativeError, onNativeEvent, type BytesResult } from "./calls"
import { reportError } from "./errors"
import { FormData } from "./formdata"
import { Headers, type HeadersInit } from "./headers"
import { runWithOwner } from "./signals"
import { byteRange, decodeUtf8, encodeUtf8 } from "./text"

export interface FetchProgress {
  /** Bytes transferred so far. */
  loaded: number
  /** Total bytes expected, or -1 when not known. */
  total: number
}

declare global {
  // Lets app code pass zero-native's extra options to the global fetch (typed by TypeScript's DOM lib).
  interface RequestInit {
    /** zero-native: limit for the whole request in ms (connect, send, wait, download). Default 30 000; 0 = none. */
    timeout?: number
    /** zero-native: the biggest response body accepted, in bytes. Default 10 MB. */
    maxBodySize?: number
    /** zero-native: called as request bytes are sent to the server. Not a web standard. */
    onUploadProgress?: (progress: FetchProgress) => void
    /** zero-native: called as response bytes arrive from the server. Not a web standard. */
    onDownloadProgress?: (progress: FetchProgress) => void
  }
}

export const DEFAULT_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_BODY_SIZE = 10_000_000

export interface FetchDefaults {
  /** Limit for the whole request in ms; 0 = none. Framework default 30 000. */
  timeout: number
  /** The biggest response body in bytes. Framework default 10 MB. */
  maxBodySize: number
}

const defaults: FetchDefaults = { timeout: DEFAULT_TIMEOUT_MS, maxBodySize: DEFAULT_MAX_BODY_SIZE }

/**
 * Changes the defaults for every later fetch in the app (a request's own `timeout` / `maxBodySize` still wins).
 * Call it once at startup, e.g. `setFetchDefaults({ timeout: 20_000 })`. Returns the new defaults.
 */
export function setFetchDefaults(next: Partial<FetchDefaults>): FetchDefaults {
  const timeout = checkLimit("timeout", next.timeout, defaults.timeout, true)
  const maxBodySize = checkLimit("maxBodySize", next.maxBodySize, defaults.maxBodySize, false)
  defaults.timeout = timeout
  defaults.maxBodySize = maxBodySize
  return { ...defaults }
}

export type BodyInit = string | ArrayBuffer | ArrayBufferView | FormData | URLSearchParams
export type RedirectMode = "follow" | "error" | "manual"

export interface FetchInit {
  method?: string
  headers?: HeadersInit
  body?: BodyInit | null
  signal?: AbortSignal | null
  /** "follow" (default); "manual" returns the 3xx response itself; "error" rejects on any redirect. */
  redirect?: RedirectMode
  timeout?: number
  maxBodySize?: number
  /** zero-native: called as request bytes are sent to the server. Not a web standard. */
  onUploadProgress?: (progress: FetchProgress) => void
  /** zero-native: called as response bytes arrive from the server. Not a web standard. */
  onDownloadProgress?: (progress: FetchProgress) => void
  // Accepted and ignored (no meaning in an app): mode, credentials, cache, referrer, referrerPolicy, integrity,
  // keepalive, priority, window.
  [ignored: string]: unknown
}

export type FetchErrorCode =
  | "offline"
  | "dns"
  | "connect"
  | "timeout"
  | "tls"
  | "cleartext_blocked"
  | "connection_lost"
  | "insecure_redirect"
  | "redirect_not_allowed"
  | "too_many_redirects"
  | "too_large"
  | "invalid_request"
  | "failed"

/**
 * A request that got no HTTP answer (network down, timeout, bad certificate, ...). A TypeError, like the web's
 * "Failed to fetch", with a `code` saying what happened. `name` is "TimeoutError" for timeouts.
 */
export class FetchError extends TypeError {
  constructor(
    readonly code: FetchErrorCode,
    message: string,
  ) {
    super(message)
    this.name = code === "timeout" ? "TimeoutError" : "TypeError"
  }
}

// ---- Request ---------------------------------------------------------------------------------------------------------

const NORMALIZED_METHODS = ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH"]
const FORBIDDEN_METHODS = ["CONNECT", "TRACE", "TRACK"]
const METHOD_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

function normalizeMethod(method: string): string {
  const m = String(method)
  if (!METHOD_TOKEN.test(m)) throw new TypeError(`fetch: "${m}" is not a valid HTTP method`)
  const upper = m.toUpperCase()
  if (FORBIDDEN_METHODS.includes(upper)) throw new TypeError(`fetch: the ${upper} method is not allowed`)
  // The web upper-cases six methods; we add PATCH, because "patch" in lower case is a common, silent server error.
  return NORMALIZED_METHODS.includes(upper) ? upper : m
}

function checkUrl(input: unknown): string {
  const url = String(input).trim()
  if (!/^https?:\/\/[^/?#]/i.test(url)) {
    throw new TypeError(`fetch: "${url}" is not a full http(s) URL (apps have no page to resolve relative URLs against)`)
  }
  return url
}

function checkLimit(name: string, value: number | undefined, fallback: number, allowZero: boolean): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new TypeError(`fetch: ${name} must be a ${allowZero ? "number ≥ 0" : "number > 0"}, got ${String(value)}`)
  }
  return value
}

export class Request {
  readonly url: string
  readonly method: string
  readonly headers: Headers
  readonly signal: AbortSignal | null
  readonly redirect: RedirectMode
  readonly timeout: number
  readonly maxBodySize: number
  readonly onUploadProgress?: (progress: FetchProgress) => void
  readonly onDownloadProgress?: (progress: FetchProgress) => void
  /** Internal: the body as given (encoded when sent). */
  readonly _body: BodyInit | null

  constructor(input: string | Request | { toString(): string }, init: FetchInit = {}) {
    const from = input instanceof Request ? input : null
    this.url = from ? from.url : checkUrl(input)
    this.method = normalizeMethod(init.method ?? from?.method ?? "GET")
    this.headers = new Headers(init.headers ?? from?.headers)
    this.signal = init.signal !== undefined ? init.signal : (from?.signal ?? null)
    const redirect = init.redirect ?? from?.redirect ?? "follow"
    if (redirect !== "follow" && redirect !== "error" && redirect !== "manual") {
      throw new TypeError(`fetch: redirect must be "follow", "error" or "manual", got "${String(redirect)}"`)
    }
    this.redirect = redirect
    this.timeout = checkLimit("timeout", init.timeout, from?.timeout ?? defaults.timeout, true)
    this.maxBodySize = checkLimit("maxBodySize", init.maxBodySize, from?.maxBodySize ?? defaults.maxBodySize, false)
    this.onUploadProgress = init.onUploadProgress ?? from?.onUploadProgress
    this.onDownloadProgress = init.onDownloadProgress ?? from?.onDownloadProgress
    this._body = init.body !== undefined ? init.body : (from?._body ?? null)
    if (this._body !== null && (this.method === "GET" || this.method === "HEAD")) {
      throw new TypeError(`fetch: a ${this.method} request can't have a body`)
    }
  }

  clone(): Request {
    return new Request(this)
  }
}

// ---- Response --------------------------------------------------------------------------------------------------------

export interface ResponseInit {
  status?: number
  statusText?: string
  headers?: HeadersInit
}

interface NativeParts {
  bytes: Uint8Array | null
  url: string
  redirected: boolean
  type: "default" | "basic" | "error"
}

function stripQuery(url: string): string {
  return url.split(/[?#]/)[0] ?? url
}

export class Response {
  readonly status: number
  readonly statusText: string
  readonly ok: boolean
  readonly headers: Headers
  /** The final URL, after redirects ("" for a Response made in JS). */
  readonly url: string
  readonly redirected: boolean
  readonly type: "default" | "basic" | "error"
  private _bytes: Uint8Array | null
  private _used = false

  /** `_parts` is internal (fetch and clone); app code passes only `body` and `init`. */
  constructor(body?: BodyInit | null, init: ResponseInit = {}, _parts?: NativeParts) {
    const status = init.status ?? 200
    if (!_parts && (!Number.isInteger(status) || status < 200 || status > 599)) {
      throw new RangeError(`Response: status must be 200–599, got ${status}`)
    }
    this.status = status
    this.statusText = init.statusText ?? ""
    this.ok = status >= 200 && status <= 299
    this.headers = new Headers(init.headers)
    this.url = _parts?.url ?? ""
    this.redirected = _parts?.redirected ?? false
    this.type = _parts?.type ?? "default"
    if (_parts) {
      this._bytes = _parts.bytes
    } else {
      const encoded = encodeBody(body ?? null, this.headers)
      if (encoded.form) throw new TypeError("Response: a FormData body is not supported")
      this._bytes = encoded.bytes ? copyBytes(encoded.bytes) : null
    }
  }

  /** Streams are not supported: always null. Use text(), json(), arrayBuffer() or bytes(). */
  get body(): null {
    return null
  }

  get bodyUsed(): boolean {
    return this._used
  }

  private take(): Uint8Array {
    if (this._used) throw new TypeError("Response body was already read; use res.clone() to read it twice")
    this._used = true
    return this._bytes ?? new Uint8Array(0)
  }

  async text(): Promise<string> {
    return decodeUtf8(this.take())
  }

  async json(): Promise<any> {
    const text = await this.text()
    const where = `Response from ${stripQuery(this.url) || "(made in JS)"}`
    if (text.trim() === "") {
      const hint = this.status === 204 ? "; check res.status before calling res.json()" : ""
      throw new SyntaxError(`${where} (status ${this.status}) has an empty body, so it isn't JSON${hint}`)
    }
    try {
      return JSON.parse(text)
    } catch (e) {
      const type = this.headers.get("content-type") ?? "no content type"
      const first = text.trimStart()[0]
      // Show the start of the body only when it clearly isn't JSON (an HTML error or login page): that is what
      // explains the error, and it isn't the app's data.
      const start = text.trim().slice(0, 60)
      const preview = first === "{" || first === "[" ? "" : `; it starts with "${start}${text.length > 60 ? "…" : ""}"`
      const reason = e instanceof Error ? e.message : String(e)
      throw new SyntaxError(`${where} (status ${this.status}, ${type}) is not valid JSON: ${reason}${preview}`)
    }
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const b = this.take()
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
  }

  async bytes(): Promise<Uint8Array> {
    return copyBytes(this.take())
  }

  clone(): Response {
    if (this._used) throw new TypeError("Response.clone: the body was already read")
    // The bytes are shared: nothing changes them (arrayBuffer() and bytes() return copies).
    return new Response(
      null,
      { status: this.status, statusText: this.statusText, headers: this.headers },
      { bytes: this._bytes, url: this.url, redirected: this.redirected, type: this.type },
    )
  }

  static json(data: unknown, init: ResponseInit = {}): Response {
    const headers = new Headers(init.headers)
    if (!headers.has("content-type")) headers.set("content-type", "application/json")
    return new Response(JSON.stringify(data), { ...init, headers })
  }

  static error(): Response {
    return new Response(null, { status: 0 }, { bytes: null, url: "", redirected: false, type: "error" })
  }

  static redirect(url: string, status = 302): Response {
    if (![301, 302, 303, 307, 308].includes(status)) throw new RangeError(`Response.redirect: bad status ${status}`)
    return new Response(null, { status, headers: { location: checkUrl(url) } })
  }
}

function copyBytes(b: ArrayBuffer | ArrayBufferView): Uint8Array {
  const [buffer, offset, length] = byteRange(b)
  return new Uint8Array(buffer.slice(offset, offset + length))
}

// ---- Bodies ----------------------------------------------------------------------------------------------------------

interface EncodedBody {
  bytes?: ArrayBuffer | ArrayBufferView
  form?: ReturnType<FormData["_parts"]>
}

/** Turns a body into bytes or form parts, setting the web's default Content-Type on `headers` where there is one. */
function encodeBody(body: BodyInit | null, headers: Headers): EncodedBody {
  if (body === null || body === undefined) return {}
  const setType = (type: string) => {
    if (!headers.has("content-type")) headers.set("content-type", type)
  }
  if (typeof body === "string") {
    const first = body.trimStart()[0]
    if ((first === "{" || first === "[") && !headers.has("content-type")) {
      warnOnce("json-type", 'fetch: the body looks like JSON but has no Content-Type; add "Content-Type": "application/json"')
    }
    setType("text/plain;charset=UTF-8")
    return { bytes: encodeUtf8(body) }
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return { bytes: body }
  const USP = (globalThis as any).URLSearchParams
  if (typeof USP === "function" && body instanceof USP) {
    setType("application/x-www-form-urlencoded;charset=UTF-8")
    return { bytes: encodeUtf8(String(body)) }
  }
  if (body instanceof FormData) {
    // Native sets multipart/form-data with the boundary; a hand-written one would lose the boundary.
    if (headers.has("content-type")) {
      warnOnce("form-type", "fetch: Content-Type is set for you for a FormData body (it needs the boundary); yours was replaced")
      headers.delete("content-type")
    }
    return { form: body._parts() }
  }
  throw new TypeError(
    "fetch: body must be a string, ArrayBuffer, typed array, URLSearchParams or FormData. For JSON use JSON.stringify(data).",
  )
}

// Owned by the network stack (the web forbids setting these too); a value set by app code is dropped.
const TRANSPORT_HEADERS = [
  "accept-encoding", // setting it turns off OkHttp's automatic unzip: the app would get compressed bytes
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]

const warned = new Set<string>()
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return
  warned.add(key)
  globalThis.__zn_log(2, message)
}

// ---- fetch -----------------------------------------------------------------------------------------------------------

interface NativeHead {
  status: number
  statusText: string
  url: string
  redirected: boolean
  headers: string[]
}

let fetchSeq = 0

export function fetch(input: string | Request | { toString(): string }, init?: FetchInit): Promise<Response> {
  let request: Request
  let args: Record<string, unknown>
  let body: EncodedBody
  try {
    request = new Request(input, init)
    const headers = new Headers(request.headers)
    body = encodeBody(request._body, headers)
    for (const name of TRANSPORT_HEADERS) {
      if (headers.has(name)) {
        warnOnce(`header-${name}`, `fetch: the "${name}" header is set by the network stack; yours was dropped`)
        headers.delete(name)
      }
    }
    args = {
      url: request.url,
      method: request.method,
      headers: headers._flat(),
      timeout: request.timeout,
      maxBodySize: request.maxBodySize,
      redirect: request.redirect,
    }
    if (body.form) args.form = body.form
  } catch (e) {
    return Promise.reject(e)
  }
  const signal = request.signal
  if (signal?.aborted) return Promise.reject(signal.reason)

  const uploadCallback = request.onUploadProgress
  const downloadCallback = request.onDownloadProgress
  const hasUpload = typeof uploadCallback === "function"
  const hasDownload = typeof downloadCallback === "function"

  let reqId: number | undefined
  if (hasUpload || hasDownload) {
    reqId = ++fetchSeq
    args.reqId = reqId
    if (hasUpload) args.uploadProgress = true
    if (hasDownload) args.downloadProgress = true
  }

  let offUpload: (() => void) | undefined
  let offDownload: (() => void) | undefined
  let active = true

  const stop = () => {
    if (!active) return
    active = false
    offUpload?.()
    offDownload?.()
    signal?.removeEventListener("abort", stop)
  }

  if (hasUpload && reqId !== undefined) {
    offUpload = runWithOwner(null, () =>
      onNativeEvent("Fetch", "uploadProgress", (p: any) => {
        if (!active || p?.id !== reqId) return
        try {
          uploadCallback!({ loaded: p.loaded ?? 0, total: p.total ?? -1 })
        } catch (e) {
          reportError("fetch onUploadProgress", e)
        }
      })
    )
  }

  if (hasDownload && reqId !== undefined) {
    offDownload = runWithOwner(null, () =>
      onNativeEvent("Fetch", "downloadProgress", (p: any) => {
        if (!active || p?.id !== reqId) return
        try {
          downloadCallback!({ loaded: p.loaded ?? 0, total: p.total ?? -1 })
        } catch (e) {
          reportError("fetch onDownloadProgress", e)
        }
      })
    )
  }

  signal?.addEventListener("abort", stop)

  return callNative<BytesResult<NativeHead>>("Fetch", "send", args, {
    signal: signal ?? undefined,
    bytes: body.bytes,
    owned: false,
  }).then(
    ({ value: head, bytes }) => {
      stop()
      return new Response(
        null,
        { status: head.status, statusText: head.statusText, headers: Headers._fromFlat(head.headers) },
        { bytes, url: head.url, redirected: head.redirected, type: "basic" },
      )
    },
    (e: unknown) => {
      stop()
      if (signal?.aborted) throw signal.reason // web rule: reject with the signal's reason (AbortError, TimeoutError)
      if (e instanceof NativeError) throw new FetchError(e.code as FetchErrorCode, e.message)
      throw e
    },
  )
}

export function installFetch(): void {
  const g = globalThis as any
  if (typeof g.fetch !== "undefined") return
  g.fetch = fetch
  g.Headers = Headers
  g.Request = Request
  g.Response = Response
  g.FormData = FormData
}
