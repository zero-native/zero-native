// Linking and Share: React Native's names for opening links and the share sheet (RN basics pack, docs/guide-notes.md
// §39). Both sit on top of Os (os.ts, android/runtime/.../ZnOs.kt).
//
//   await Linking.openURL("https://example.com/help")
//   await Share.share({ message: "Try this app", title: "Invite" })
//
// openURL opens any app's link, as in RN (whatsapp:, upi:, sms:, geo:, market:; since 2026-11-08). Only intent:, file:
// and javascript: links, and links with no scheme, are refused with `not_allowed` (ZnOs.kt). Which links to open is the
// app's job, as in RN: filter links written by others (a merchant's text, a server's field) before opening them.
// Opening an app for a result (a UPI payment's answer) still goes through a plugin's Kotlin (ZnLaunch + launches).
import { initialLink, onOpenedLink } from "./nav"
import { Os } from "./os"
import { getOwner, onCleanup } from "./signals"

export const Linking = {
  /** Opens [url] in another app. Rejects with a NativeError: `not_allowed` (intent:, file:, javascript:, no scheme), `no_app`. */
  openURL(url: string): Promise<true> {
    return Os.openUrl(url).then(() => true as const)
  },

  /**
   * True if some app can open [url]. False for links openURL would refuse. Android 11+ answers only for schemes in a
   * manifest's `<queries>` (the runtime lists http, https, mailto, tel): add the others you ask about, as in RN.
   */
  canOpenURL(url: string): Promise<boolean> {
    return Os.canOpenUrl(url)
  },

  /** The app's page in Android settings. */
  openSettings(): Promise<void> {
    return Os.openSettings().then(() => undefined)
  },

  /**
   * The link that started the app, or null. Only a link that matched a route with `deepLink: true` and got past
   * `onLink` (startApp) reaches JS: by then its screen is already open. Waits for the first screens.
   */
  getInitialURL(): Promise<string | null> {
    return initialLink()
  },

  /**
   * Calls [handler] with each link that opens its screen while the app runs (after `onLink` allowed it). The screen
   * opens by itself: use this to know, not to route. Returns `{ remove }`; in a screen body it stops when the screen
   * closes. To refuse a link, use `onLink` in startApp.
   */
  addEventListener(type: "url", handler: (event: { url: string }) => void): { remove(): void } {
    if (type !== "url") throw new TypeError(`Linking.addEventListener: unknown event "${type}"`)
    const remove = onOpenedLink((url) => handler({ url }))
    if (getOwner()) onCleanup(remove)
    return { remove }
  },
}

export interface ShareContent {
  /** The text to share. */
  message?: string
  /** The subject (of an email, say). */
  title?: string
  /** React Native shares a url only on iOS. Here, as a fallback, it is shared as the text when there is no message. */
  url?: string
}

export interface ShareOptions {
  /** The title of Android's share sheet. */
  dialogTitle?: string
}

export const Share = {
  sharedAction: "sharedAction" as const,
  dismissedAction: "dismissedAction" as const,

  /**
   * Android's share sheet. Like React Native on Android it always answers "sharedAction" once the sheet opened:
   * Android doesn't say whether the user picked an app.
   */
  share(content: ShareContent, options: ShareOptions = {}): Promise<{ action: "sharedAction" }> {
    const text = content.message ?? content.url
    if (typeof text !== "string") return Promise.reject(new TypeError("Share.share: give a message"))
    return Os.share({ text, subject: content.title, dialogTitle: options.dialogTitle }).then(() => ({ action: "sharedAction" as const }))
  },
}
