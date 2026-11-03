// The webview plugin's JS side, without the component (WebView.tsx). Native side: android/.../WebViewModule.kt.
// No side effects: nativeModule() only creates a handle.
import { nativeModule } from "@zero-native/core"

/** Why a command did nothing. no_view: the view isn't on screen. no_page: the page hasn't sent a message yet, or left. */
export interface SentAnswer {
  sent: boolean
  reason?: "no_view" | "no_page" | "too_long"
}

export interface OpenedAnswer {
  opened: boolean
  reason?: "no_view" | "refused" | "no_activity" | "no_app"
}

export interface WebViewNativeModule {
  goBack(args: { view: string }): Promise<boolean>
  reload(args: { view: string }): Promise<boolean>
  postMessage(args: { view: string; text: string }): Promise<SentAnswer>
  openLink(args: { view: string; url: string }): Promise<OpenedAnswer>
  /** Removes all cookies of all pages in this app, on disk too. */
  clearCookies(): Promise<boolean>
  /** Removes localStorage and the like. Cookies stay. */
  clearStorage(): Promise<boolean>
  /** Debug builds only: kills the page's renderer, for tests. */
  debugRenderer(args: { view: string; how: "crash" | "terminate" }): Promise<boolean>
}

export const WebViewNative = nativeModule<WebViewNativeModule>("WebView", { version: 1 })

/** From the page, so outside input: check it as you would any text from the network. */
export interface WebViewMessage {
  text: string
  /** The sender's origin, as WebView says it: always one of your allowed hosts. */
  origin: string
  /** false: it came from an iframe on an allowed host. */
  mainFrame: boolean
}

/** A link that wants to leave the app. */
export interface WebViewLink {
  url: string
  scheme: string
  /** The user tapped. false: the page's script did it, so don't trust it as much. */
  gesture: boolean
}

export interface WebViewError {
  /** http: the server answered with an error. network: no answer. ssl: bad certificate (never passed). blocked: host not allowed. no_webview: this phone can't make one now. */
  kind: "http" | "network" | "ssl" | "blocked" | "no_webview"
  url: string
  status?: number
  code?: number
  description: string
}

export interface WebViewFinish {
  url: string
  ok: boolean
  status: number | null
  title: string
  canGoBack: boolean
}

/** Commands for one view. Make one with `webViewController()` and give it to `<WebView controller={...} />`. */
export interface WebViewController {
  /** Goes back in the page. false: there is nothing to go back to. */
  back(): Promise<boolean>
  /** Loads the page again. After `onRenderGone`, this makes a new view. false: not on screen. */
  reload(): Promise<boolean>
  /** Sends text to the page, to `window.ZeroNative`'s "message" event. The page must have sent one message first. */
  postMessage(text: string): Promise<SentAnswer>
  /** Opens a link in another app. Only a link whose scheme is in `leaveSchemes`. */
  openLink(url: string): Promise<OpenedAnswer>
  /** The view's id, null until it is ready. */
  view(): string | null
  /** For the lab's tests. Debug builds only. */
  debugRenderer(how: "crash" | "terminate"): Promise<boolean>
}

interface ControllerParts extends WebViewController {
  attach(view: string | null): void
}

export function webViewController(): WebViewController {
  let id: string | null = null
  const c: ControllerParts = {
    back: () => (id === null ? Promise.resolve(false) : WebViewNative.goBack({ view: id })),
    reload: () => (id === null ? Promise.resolve(false) : WebViewNative.reload({ view: id })),
    postMessage: (text) => (id === null ? Promise.resolve({ sent: false, reason: "no_view" }) : WebViewNative.postMessage({ view: id, text })),
    openLink: (url) => (id === null ? Promise.resolve({ opened: false, reason: "no_view" }) : WebViewNative.openLink({ view: id, url })),
    view: () => id,
    debugRenderer: (how) => (id === null ? Promise.resolve(false) : WebViewNative.debugRenderer({ view: id, how })),
    attach: (view) => {
      id = view
    },
  }
  return c
}

export interface WebViewOptions {
  /** The page to load. Its host must be in `allowedHosts`, or nothing loads. */
  url?: string
  /** Your own html, instead of `url`. With no `baseUrl` it has no origin, so no bridge and no upload. */
  html?: string
  /** The address `html` acts as. Its host must be in `allowedHosts`. */
  baseUrl?: string
  /** Sent with the first request only, not with the page's own requests, and not with `reload()`. */
  headers?: Record<string, string>
  /**
   * The only hosts a page may come from: `pay.example.com`, `port.example:8443`, `*.example.com` (what is under it, not
   * itself). https only; debug builds can also use `http://localhost:port`. Empty: only `html` with no `baseUrl` shows.
   */
  allowedHosts: string[]
  /** Schemes that may ask to leave: `tel`, `mailto`, `upi`, `https`. `intent`, `file`, `content` and the like are always refused. */
  leaveSchemes?: string[]
  /** Default true. */
  javaScript?: boolean
  /** Default false. */
  thirdPartyCookies?: boolean
  /** Default true. A page on an allowed host can open the system file picker. */
  fileUpload?: boolean
  /** Default true: system Back goes back in the page first, before `useBack`. false: use `useBack` and `controller.back()`. */
  backInPage?: boolean
}

export interface WebViewHandlers {
  /** Default: makes its own, with no way to reach it. */
  controller?: WebViewController
  /** `bridge`: false if this phone's WebView can't do messages. `refused`: entries of allowedHosts or leaveSchemes that were dropped. */
  onReady?: (info: { view: string; bridge: boolean; refused: string[] }) => void
  onLoadStart?: (url: string) => void
  onLoadFinish?: (page: WebViewFinish) => void
  onLoadError?: (error: WebViewError) => void
  /** 0 to 100. */
  onProgress?: (percent: number) => void
  onTitle?: (title: string) => void
  /** For each history change, also in a single-page app. */
  onNavigate?: (page: { url: string; canGoBack: boolean }) => void
  onMessage?: (message: WebViewMessage) => void
  /** Return true to open the link in another app. With no handler, nothing leaves. */
  onLinkOutside?: (link: WebViewLink) => boolean
  /** reason: host, scheme, frame or bad_url. */
  onLinkRefused?: (link: { url: string; reason: string }) => void
  /** The file picker answered. 0: cancelled. */
  onUpload?: (count: number) => void
  /** The page's renderer died; the app lives. The view is empty until `controller.reload()`. */
  onRenderGone?: (info: { crashed: boolean }) => void
  /** The screen is covered, or the app left the screen: the page is paused. */
  onPause?: () => void
  onResume?: () => void
}

/** What the view gets. Only what isn't a default, so a change of a handler sends nothing. */
export function viewProps(p: WebViewOptions): Record<string, unknown> {
  return {
    url: p.url,
    html: p.html,
    baseUrl: p.baseUrl,
    headers: p.headers,
    allowedHosts: p.allowedHosts,
    leaveSchemes: p.leaveSchemes,
    javaScript: p.javaScript,
    thirdPartyCookies: p.thirdPartyCookies,
    fileUpload: p.fileUpload,
    backInPage: p.backInPage,
  }
}

/** One event from the view. Kept out of the component so a test can call it. */
export function onWebViewEvent(controller: WebViewController, h: WebViewHandlers, e: { name: string; data: any }): void {
  const d = e.data
  switch (e.name) {
    case "ready":
      ;(controller as ControllerParts).attach(d.view)
      return h.onReady?.(d)
    case "loadStart":
      return h.onLoadStart?.(d.url)
    case "loadFinish":
      return h.onLoadFinish?.(d)
    case "loadError":
      return h.onLoadError?.(d)
    case "progress":
      return h.onProgress?.(d)
    case "title":
      return h.onTitle?.(d)
    case "nav":
      return h.onNavigate?.(d)
    case "message":
      return h.onMessage?.(d)
    case "linkOutside":
      if (h.onLinkOutside?.(d) === true) void controller.openLink(d.url)
      return
    case "linkRefused":
      return h.onLinkRefused?.(d)
    case "upload":
      return h.onUpload?.(d.count)
    case "renderGone":
      return h.onRenderGone?.(d)
    case "paused":
      return h.onPause?.()
    case "resumed":
      return h.onResume?.()
  }
}

/** The view left the screen: commands answer "no_view" until it is ready again. */
export function detachController(controller: WebViewController): void {
  ;(controller as ControllerParts).attach(null)
}
