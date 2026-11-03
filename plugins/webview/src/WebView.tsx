// A web page inside a screen. The component only passes things on: the rules are in Kotlin (WebViewRules.kt).
import { onCleanup } from "@zero-native/core"
import { NativeView } from "@zero-native/ui"
import { detachController, onWebViewEvent, viewProps, webViewController, type WebViewHandlers, type WebViewOptions } from "./api"

export type WebViewProps = WebViewOptions & WebViewHandlers

/**
 * Fills the Column around it (`flex: 1`): the size comes from that Column, as `style` can't be passed through a component.
 * Don't put it in a `Scroll`: the page scrolls by itself.
 */
export function WebView(p: WebViewProps) {
  const controller = p.controller ?? webViewController()
  onCleanup(() => detachController(controller))
  return <NativeView name="webview.page" props={viewProps(p)} onEvent={(e) => onWebViewEvent(controller, p, e)} style={{ flex: 1 }} />
}
