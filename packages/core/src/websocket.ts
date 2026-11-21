// The browser WebSocket API for zero-native apps.
// Built on OkHttp on Android (uses the shared ZnFetch.client so pins and interceptors apply), on
// URLSessionWebSocketTask on iOS. Native side: android/runtime/.../ZnWebSocket.kt, ios/ZnRuntime/Swift/ZnWebSocket.swift.
// Differences from browsers: docs/fetch.md §8.
import { callNative, NativeError, onNativeEvent } from "./calls"
import { reportError } from "./errors"
import { runWithOwner } from "./signals"
import { ZnURL } from "./url"

export type BinaryType = "blob" | "arraybuffer"

export class WebSocketEvent {
  readonly type: string
  readonly target: WebSocket
  readonly currentTarget: WebSocket
  constructor(type: string, target: WebSocket) {
    this.type = type
    this.target = target
    this.currentTarget = target
  }
}

export class WebSocketMessageEvent extends WebSocketEvent {
  readonly data: string
  readonly origin: string
  constructor(target: WebSocket, data: string, origin: string) {
    super("message", target)
    this.data = data
    this.origin = origin
  }
}

export class WebSocketCloseEvent extends WebSocketEvent {
  readonly code: number
  readonly reason: string
  readonly wasClean: boolean
  constructor(target: WebSocket, code: number, reason: string, wasClean: boolean) {
    super("close", target)
    this.code = code
    this.reason = reason
    this.wasClean = wasClean
  }
}

export class WebSocketErrorEvent extends WebSocketEvent {
  readonly message: string
  readonly error?: unknown
  constructor(target: WebSocket, message: string, error?: unknown) {
    super("error", target)
    this.message = message
    this.error = error
  }
}

type EventListener<E extends WebSocketEvent = WebSocketEvent> = (evt: E) => void

// Socket ids start at a random number in each JS runtime. Native events carry the id, and after a dev reload or an
// OTA restart a late event of an old socket could otherwise reach a new socket that got the same small number.
// Stays below 2^31: native reads the id as an Int.
let wsSeq = Math.floor(Math.random() * 0x3fffffff)
const MAX_MESSAGE_SIZE = 1_048_576 // 1 MB cap in UTF-8 bytes, like native (second-opinions 161)

/**
 * The UTF-8 size of [s] in bytes, without making the bytes. Native counts the same way (Okio utf8Size), except a lone
 * surrogate: 3 bytes here (U+FFFD), 1 byte there ("?"). So JS is never less strict than native.
 */
export function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4
        i++
      } else n += 3
    } else n += 3
  }
  return n
}

/** A DOMException with the web's name (InvalidStateError, ...); a plain Error with that name if there is none. */
function domError(message: string, name: string): Error {
  const D = (globalThis as any).DOMException
  if (typeof D === "function") return new D(message, name)
  const e = new Error(message)
  e.name = name
  return e
}

/** RFC 6455 subprotocol names are HTTP tokens (RFC 7230 tchar). */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

function checkWsUrl(url: string | { toString(): string }): { href: string; origin: string } {
  const s = String(url)
  let parsed: ZnURL
  try {
    parsed = new ZnURL(s)
  } catch {
    throw new SyntaxError(`The URL '${s}' is invalid.`)
  }
  const scheme = parsed.protocol.slice(0, -1)
  if (scheme !== "ws" && scheme !== "wss") {
    throw new SyntaxError(`The URL's scheme must be either 'ws' or 'wss'. Got '${scheme}:'.`)
  }
  if (parsed.hostname === "") {
    throw new SyntaxError(`The URL '${s}' has no host.`)
  }
  const href = parsed.href
  // A "#" in the serialized URL can only start a fragment ("ws://a/#" has an empty one; browsers reject it too).
  if (href.includes("#")) {
    throw new SyntaxError(`The URL contains a fragment identifier ('${parsed.hash || "#"}'). Fragment identifiers are not allowed in WebSocket URLs.`)
  }
  return { href, origin: parsed.origin }
}

export class WebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3

  /** The full URL, as browsers give it (parsed and serialized: "ws://host" becomes "ws://host/"). */
  readonly url: string
  readonly extensions: string = ""
  binaryType: BinaryType = "blob"

  private _readyState: number = WebSocket.CONNECTING
  private _protocol: string = ""
  private _bufferedAmount: number = 0
  private readonly _id: number
  /** scheme://host[:port], the `origin` of message events. */
  private readonly _origin: string

  private _onopen: ((this: WebSocket, ev: WebSocketEvent) => any) | null = null
  private _onmessage: ((this: WebSocket, ev: WebSocketMessageEvent) => any) | null = null
  private _onerror: ((this: WebSocket, ev: WebSocketErrorEvent) => any) | null = null
  private _onclose: ((this: WebSocket, ev: WebSocketCloseEvent) => any) | null = null

  /** type → listener → once. A Map keeps the order listeners were added in. */
  private readonly _listeners = new Map<string, Map<EventListener<any>, boolean>>()
  private readonly _unsubs: Array<() => void> = []

  constructor(url: string | { toString(): string }, protocols?: string | string[]) {
    const checked = checkWsUrl(url)
    this.url = checked.href
    this._origin = checked.origin

    let protoList: string[] = []
    if (typeof protocols === "string") {
      protoList = [protocols]
    } else if (Array.isArray(protocols)) {
      protoList = protocols
    } else if (protocols !== undefined && protocols !== null) {
      throw new SyntaxError("protocols must be a string or array of strings")
    }
    const seen = new Set<string>()
    for (const p of protoList) {
      if (typeof p !== "string" || seen.has(p)) {
        throw new SyntaxError(`The subprotocol '${p}' is duplicated or not a string.`)
      }
      if (!TOKEN.test(p)) {
        throw new SyntaxError(`The subprotocol '${p}' is invalid.`)
      }
      seen.add(p)
    }

    this._id = ++wsSeq
    this._setupNative(protoList)
  }

  get readyState(): number {
    return this._readyState
  }

  get protocol(): string {
    return this._protocol
  }

  get bufferedAmount(): number {
    return this._bufferedAmount
  }

  get onopen(): ((this: WebSocket, ev: WebSocketEvent) => any) | null {
    return this._onopen
  }
  set onopen(fn: ((this: WebSocket, ev: WebSocketEvent) => any) | null) {
    this._onopen = fn
  }

  get onmessage(): ((this: WebSocket, ev: WebSocketMessageEvent) => any) | null {
    return this._onmessage
  }
  set onmessage(fn: ((this: WebSocket, ev: WebSocketMessageEvent) => any) | null) {
    this._onmessage = fn
  }

  get onerror(): ((this: WebSocket, ev: WebSocketErrorEvent) => any) | null {
    return this._onerror
  }
  set onerror(fn: ((this: WebSocket, ev: WebSocketErrorEvent) => any) | null) {
    this._onerror = fn
  }

  get onclose(): ((this: WebSocket, ev: WebSocketCloseEvent) => any) | null {
    return this._onclose
  }
  set onclose(fn: ((this: WebSocket, ev: WebSocketCloseEvent) => any) | null) {
    this._onclose = fn
  }

  send(data: unknown): void {
    if (this._readyState === WebSocket.CONNECTING) {
      throw domError("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", "InvalidStateError")
    }
    if (typeof data !== "string") {
      throw new TypeError("zero-native WebSocket v1 supports text frames only; send(string) required")
    }
    // CLOSING / CLOSED: dropped quietly, like browsers (they don't throw here either).
    if (this._readyState !== WebSocket.OPEN) return
    if (utf8Length(data) > MAX_MESSAGE_SIZE) {
      throw new RangeError("WebSocket message exceeds 1 MB limit (second-opinions 161)")
    }

    callNative("WebSocket", "send", { id: this._id, data }, { owned: false }).catch((e) => {
      // The socket closed or failed on the native side just before this send; its close event is on the way.
      if (e instanceof NativeError && (e.code === "not_found" || e.code === "send_failed")) {
        globalThis.__zn_log(2, `WebSocket send dropped: ${e.message}`)
        return
      }
      reportError("WebSocket send", e)
    })
  }

  close(code?: number, reason?: string): void {
    // Arguments are checked first, in every state (WHATWG order).
    if (code !== undefined) {
      const n = Number(code)
      // WebIDL [Clamp] unsigned short: rounded, then kept in 0..65535.
      const c = Number.isNaN(n) ? 0 : Math.min(65535, Math.max(0, Math.round(n)))
      if (c !== 1000 && (c < 3000 || c > 4999)) {
        throw domError(`The close code must be either 1000, or between 3000 and 4999. Received: ${code}`, "InvalidAccessError")
      }
      code = c
    }
    if (reason !== undefined) {
      reason = String(reason)
      if (utf8Length(reason) > 123) {
        throw new SyntaxError("The close reason must not be greater than 123 bytes.")
      }
    }
    if (this._readyState === WebSocket.CLOSING || this._readyState === WebSocket.CLOSED) {
      return
    }

    // While CONNECTING, browsers fail the connection: error, then close 1006. Native cancels the connect for that.
    const abort = this._readyState === WebSocket.CONNECTING
    this._readyState = WebSocket.CLOSING
    callNative(
      "WebSocket",
      "close",
      { id: this._id, code: code ?? 1000, reason: reason ?? "", abort },
      { owned: false },
    ).catch((e) => {
      globalThis.__zn_log(2, `WebSocket close: ${e instanceof Error ? e.message : String(e)}`)
    })
  }

  addEventListener(type: string, listener: EventListener<any>, options?: boolean | { once?: boolean }): void {
    if (typeof listener !== "function") return
    let set = this._listeners.get(type)
    if (!set) this._listeners.set(type, (set = new Map()))
    if (set.has(listener)) return // the web adds a listener once; the first options win
    set.set(listener, typeof options === "object" && options !== null && options.once === true)
  }

  removeEventListener(type: string, listener: EventListener<any>): void {
    const set = this._listeners.get(type)
    if (set) set.delete(listener)
  }

  dispatchEvent(evt: WebSocketEvent): boolean {
    this._dispatch(evt.type, evt)
    return true
  }

  private _dispatch(type: string, evt: WebSocketEvent): void {
    const fn = (this as any)["_on" + type]
    if (typeof fn === "function") {
      try {
        fn.call(this, evt)
      } catch (e) {
        reportError(`WebSocket on${type}`, e)
      }
    }
    const set = this._listeners.get(type)
    if (set) {
      for (const [listener, once] of [...set]) {
        if (!set.has(listener)) continue // removed by a listener before it, during this event
        if (once) set.delete(listener)
        try {
          listener.call(this, evt)
        } catch (e) {
          reportError(`WebSocket ${type} listener`, e)
        }
      }
    }
  }

  private _setupNative(protocols: string[]): void {
    const id = this._id

    const listen = (event: string, handler: (payload: any) => void) => {
      const unsub = runWithOwner(null, () =>
        onNativeEvent("WebSocket", event, (p: any) => {
          if (p?.id === id) handler(p)
        }),
      )
      this._unsubs.push(unsub)
    }

    listen("open", (p) => {
      if (this._readyState === WebSocket.CONNECTING) {
        this._readyState = WebSocket.OPEN
        this._protocol = p?.protocol ?? ""
        this._dispatch("open", new WebSocketEvent("open", this))
      }
    })

    listen("message", (p) => {
      if (this._readyState === WebSocket.OPEN) {
        this._dispatch("message", new WebSocketMessageEvent(this, String(p?.data ?? ""), this._origin))
      }
    })

    listen("closing", () => {
      if (this._readyState === WebSocket.OPEN) {
        this._readyState = WebSocket.CLOSING
      }
    })

    listen("error", (p) => {
      if (this._readyState !== WebSocket.CLOSED) {
        this._dispatch("error", new WebSocketErrorEvent(this, p?.message ?? "WebSocket error"))
      }
    })

    listen("close", (p) => {
      if (this._readyState !== WebSocket.CLOSED) {
        this._readyState = WebSocket.CLOSED
        this._cleanup()
        this._dispatch(
          "close",
          new WebSocketCloseEvent(this, p?.code ?? 1000, p?.reason ?? "", p?.wasClean ?? true),
        )
      }
    })

    callNative(
      "WebSocket",
      "connect",
      { id, url: this.url, protocols },
      { owned: false },
    ).catch((e) => {
      if (this._readyState !== WebSocket.CLOSED) {
        this._readyState = WebSocket.CLOSED
        this._cleanup()
        this._dispatch("error", new WebSocketErrorEvent(this, e.message ?? "Connection failed", e))
        this._dispatch("close", new WebSocketCloseEvent(this, 1006, e.message ?? "Connection failed", false))
      }
    })
  }

  private _cleanup(): void {
    for (const unsub of this._unsubs) {
      try {
        unsub()
      } catch {}
    }
    this._unsubs.length = 0
  }
}

export function installWebSocket(): void {
  const g = globalThis as any
  if (typeof g.WebSocket !== "undefined") return
  g.WebSocket = WebSocket
}
