// The browser WebSocket API for zero-native apps.
// Built on OkHttp on Android (uses the shared ZnFetch.client so pins and interceptors apply).
import { callNative, onNativeEvent } from "./calls"
import { reportError } from "./errors"
import { runWithOwner } from "./signals"

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

let wsSeq = 0
const MAX_MESSAGE_SIZE = 1_048_576 // 1 MB cap (second-opinions 161)

function checkWsUrl(url: string | { toString(): string }): string {
  const s = String(url)
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(s)
  if (!match) {
    throw new SyntaxError(`The URL '${s}' is invalid.`)
  }
  const scheme = match[1].toLowerCase()
  if (scheme !== "ws" && scheme !== "wss") {
    throw new SyntaxError(`The URL's scheme must be either 'ws' or 'wss'. Got '${scheme}:'.`)
  }
  return s
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

  readonly url: string
  readonly extensions: string = ""
  binaryType: BinaryType = "blob"

  private _readyState: number = WebSocket.CONNECTING
  private _protocol: string = ""
  private _bufferedAmount: number = 0
  private readonly _id: number

  private _onopen: ((this: WebSocket, ev: WebSocketEvent) => any) | null = null
  private _onmessage: ((this: WebSocket, ev: WebSocketMessageEvent) => any) | null = null
  private _onerror: ((this: WebSocket, ev: WebSocketErrorEvent) => any) | null = null
  private _onclose: ((this: WebSocket, ev: WebSocketCloseEvent) => any) | null = null

  private readonly _listeners = new Map<string, Set<EventListener<any>>>()
  private readonly _unsubs: Array<() => void> = []

  constructor(url: string | { toString(): string }, protocols?: string | string[]) {
    this.url = checkWsUrl(url)
    this._id = ++wsSeq

    let protoList: string[] = []
    if (typeof protocols === "string") {
      protoList = [protocols]
    } else if (Array.isArray(protocols)) {
      const seen = new Set<string>()
      for (const p of protocols) {
        if (typeof p !== "string" || seen.has(p)) {
          throw new SyntaxError(`The subprotocol '${p}' is duplicated or not a string.`)
        }
        seen.add(p)
      }
      protoList = protocols
    } else if (protocols !== undefined && protocols !== null) {
      throw new SyntaxError("protocols must be a string or array of strings")
    }

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
      const err = new Error("InvalidStateError: WebSocket is still in CONNECTING state.")
      err.name = "InvalidStateError"
      throw err
    }
    if (this._readyState !== WebSocket.OPEN) {
      const err = new Error("InvalidStateError: WebSocket is not open.")
      err.name = "InvalidStateError"
      throw err
    }
    if (typeof data !== "string") {
      throw new TypeError("zero-native WebSocket v1 supports text frames only; send(string) required")
    }
    if (data.length > MAX_MESSAGE_SIZE) {
      throw new RangeError("WebSocket message exceeds 1 MB limit (second-opinions 161)")
    }

    callNative("WebSocket", "send", { id: this._id, data }, { owned: false }).catch((e) => {
      reportError("WebSocket send", e)
    })
  }

  close(code?: number, reason?: string): void {
    if (this._readyState === WebSocket.CLOSING || this._readyState === WebSocket.CLOSED) {
      return
    }
    if (code !== undefined) {
      if (code !== 1000 && (code < 3000 || code > 4999)) {
        throw new RangeError(`The close code must be either 1000, or between 3000 and 4999. Received: ${code}`)
      }
    }
    if (reason !== undefined) {
      if (new TextEncoder().encode(reason).length > 123) {
        throw new SyntaxError("The close reason must not be greater than 123 bytes.")
      }
    }

    this._readyState = WebSocket.CLOSING
    callNative(
      "WebSocket",
      "close",
      { id: this._id, code: code ?? 1000, reason: reason ?? "" },
      { owned: false },
    ).catch(() => {})
  }

  addEventListener(type: string, listener: EventListener<any>): void {
    if (typeof listener !== "function") return
    let set = this._listeners.get(type)
    if (!set) this._listeners.set(type, (set = new Set()))
    set.add(listener)
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
      for (const listener of [...set]) {
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
        this._dispatch("message", new WebSocketMessageEvent(this, String(p?.data ?? ""), this.url))
      }
    })

    listen("closing", () => {
      if (this._readyState === WebSocket.OPEN) {
        this._readyState = WebSocket.CLOSING
      }
    })

    listen("error", (p) => {
      this._dispatch("error", new WebSocketErrorEvent(this, p?.message ?? "WebSocket error"))
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
