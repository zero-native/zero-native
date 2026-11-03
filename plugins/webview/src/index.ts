// The webview plugin's JS side. Native side: android/.../WebViewModule.kt. No side effects: nativeModule() only creates a handle.
export { WebView, type WebViewProps } from "./WebView"
export {
  WebViewNative,
  webViewController,
  type OpenedAnswer,
  type SentAnswer,
  type WebViewController,
  type WebViewError,
  type WebViewFinish,
  type WebViewHandlers,
  type WebViewLink,
  type WebViewMessage,
  type WebViewOptions,
} from "./api"
