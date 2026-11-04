// The push plugin's JS side. Native side: android/.../PushPlugin.kt (Firebase Cloud Messaging, NotificationCompat).
//
// At the top of main.ts (a message can start the app with no screen, so these must be there before any screen):
//
//   Push.onMessage(async (m, signal) => {                   // every data message: app in front, behind, or closed
//     if (m.data.type === "offer") await Notifications.show({ id: m.data.id, channelId: "offers", title: m.data.title,
//       body: m.data.body, link: `myapp://offers/${m.data.id}`, group: { key: "offers", summaryFormat: "%d new offers" } })
//   })
//   Push.onTokenRefresh(({ token }) => sendTokenToServer(token))
//
// At start, and after login:
//
//   await Notifications.createChannel({ id: "offers", name: "Offers", importance: "high" })
//   const { token } = await Push.getToken()                    // null with a reason when there is none now
//   if (token && token !== saved) sendTokenToServer(token)
//
// On a tap ("Turn on notifications"): `Permissions.request(["notifications"])` from core (Android 13+ asks; older: on).
// A tap on a notification opens its `link` through the app's normal link path (`onLink` in startApp).
// Each call answers with a value and never rejects. With no Firebase (no google-services.json) Push says
// `available: false`; Notifications still work.
import { defineTask, nativeModule, type CallOptions } from "@zero-native/core"

/** Core task names the native side runs (PushRules.kt). */
export const MESSAGE_TASK = "push.message"
export const TOKEN_TASK = "push.token"
export const DISMISS_TASK = "push.dismissed"

export interface PushMessage {
  messageId: string | null
  /** The sender id, or `/topics/<name>` for a topic message. */
  from: string | null
  /** When the server sent it, ms since 1970. */
  sentAt: number
  /** "high" may start the app from Doze. Android lowers it to "normal" for apps that misuse it. */
  priority: "high" | "normal" | "unknown"
  originalPriority: "high" | "normal" | "unknown"
  /** The app was on screen. */
  inFront: boolean
  /** The message's data, all strings (FCM's rule). Never log it as a whole: it may hold anything. */
  data: Record<string, string>
  /** The `notification` block, if the server sent one. Android shows such a message itself while the app is behind. */
  notification: { title: string | null; body: string | null } | null
  /** True once: FCM dropped messages it couldn't deliver (offline too long). Sync with your server instead. */
  deleted?: boolean
}

export type TokenReason =
  /** No Firebase in this app (no google-services.json), or the plugin is missing. */
  | "unavailable"
  /** No network, or no Play services right now. Try again later. */
  | "not_now"
  /** The phone has no Google Play services: no FCM on it. */
  | "no_play_services"
  | "failed"

export type TokenResult = { token: string; reason: null } | { token: null; reason: TokenReason }

export type Importance = "none" | "min" | "low" | "default" | "high"

export interface Channel {
  /** Kept for good: Android lets the user change it after, so its importance and sound never change again. */
  id: string
  /** Shown in the phone's settings. Can change later. */
  name: string
  /** "high" pops up on screen. Default "default". */
  importance?: Importance
  description?: string
  /** Default true. */
  sound?: boolean
  /** Default true. */
  vibration?: boolean
  /** Default false. */
  lights?: boolean
  /** The dot on the app icon. Default true. */
  badge?: boolean
}

export interface ShowOptions {
  /** Yours. Showing the same id again replaces it. */
  id: string
  channelId: string
  title: string
  body?: string
  /** The text when expanded. Without it, a body longer than ~40 characters expands by itself. */
  bigText?: string
  /** Opened on a tap, through the app's link path. Another app's or a web link opens there. None: the app opens. */
  link?: string
  /** https only (http also in debug builds). Downloaded natively in at most 4 s, else left out. */
  largeIconUrl?: string
  /** A big picture when expanded. Same rules as largeIconUrl. */
  imageUrl?: string
  /** Notifications with the same key are grouped. From 2 on, a summary shows (the newest 5 lines). */
  group?: { key: string; title?: string; summaryFormat?: string; link?: string }
  /** Strings given back to `onDismiss`. */
  data?: Record<string, string>
  /** Removed when tapped. Default true. */
  autoCancel?: boolean
}

export type BlockedReason =
  /** The app's notifications are off: no permission (Android 13+), or the user turned them off. */
  | "off"
  | "no_channel"
  /** The user turned this channel off. */
  | "channel_blocked"

export interface PushModule {
  status(args?: Record<string, never>, options?: CallOptions): Promise<{ available: boolean }>
  getToken(args?: Record<string, never>, options?: CallOptions): Promise<TokenResult>
  deleteToken(args?: Record<string, never>, options?: CallOptions): Promise<boolean>
  subscribe(args: { topic: string }, options?: CallOptions): Promise<boolean>
  unsubscribe(args: { topic: string }, options?: CallOptions): Promise<boolean>
}

export interface NotificationsModule {
  createChannel(args: Channel, options?: CallOptions): Promise<boolean>
  deleteChannel(args: { id: string }, options?: CallOptions): Promise<boolean>
  canShow(args: { channelId?: string }, options?: CallOptions): Promise<{ reason: BlockedReason | null }>
  show(args: ShowOptions, options?: CallOptions): Promise<{ shown: boolean; reason: BlockedReason | null }>
  cancel(args: { id: string }, options?: CallOptions): Promise<boolean>
  cancelAll(args?: Record<string, never>, options?: CallOptions): Promise<boolean>
}

const NativePush = nativeModule<PushModule>("Push", { version: 1 })
const NativeNotifications = nativeModule<NotificationsModule>("Notifications", { version: 1 })
// Not tied to a screen: a task has no screen, and a token sync must not stop because a screen closed.
const unowned = { owned: false }
const no = () => false

export const Push = {
  /** `{ available }`: false with no Firebase in this app. */
  status: (): Promise<{ available: boolean }> => NativePush.status({}, unowned).catch(() => ({ available: false })),

  /** The FCM token for this install, or null with a reason. It can change: listen with `onTokenRefresh` too. */
  getToken: (): Promise<TokenResult> =>
    NativePush.getToken({}, unowned).catch((): TokenResult => ({ token: null, reason: "unavailable" })),

  /** On logout: the old token stops working; the next `getToken` makes a new one. */
  deleteToken: (): Promise<boolean> => NativePush.deleteToken({}, unowned).catch(no),

  /** FCM topics ("ota-android-staging"). Letters, digits and - _ . ~ % only. */
  subscribe: (topic: string): Promise<boolean> => NativePush.subscribe({ topic }, unowned).catch(no),
  unsubscribe: (topic: string): Promise<boolean> => NativePush.unsubscribe({ topic }, unowned).catch(no),

  /**
   * Every data message, in front, behind or closed (RN Firebase's onMessage and setBackgroundMessageHandler in one). Call
   * it once, at the top of main.ts. [handler] has 15 s; `signal` aborts at the limit.
   */
  onMessage: (handler: (message: PushMessage, signal: AbortSignal) => unknown): void => defineTask<PushMessage>(MESSAGE_TASK, handler),

  /** A new token, also while the app was closed. Call it once, at the top of main.ts. */
  onTokenRefresh: (handler: (event: { token: string }, signal: AbortSignal) => unknown): void => defineTask(TOKEN_TASK, handler),
}

export const Notifications = {
  /** Android 8+: needed before `show`. Safe to call at every start. Below Android 8 it does nothing. */
  createChannel: (channel: Channel): Promise<boolean> => NativeNotifications.createChannel(channel, unowned).catch(no),
  deleteChannel: (id: string): Promise<boolean> => NativeNotifications.deleteChannel({ id }, unowned).catch(no),

  /** Null: a notification on [channelId] would show now. Else why not. No dialog. */
  canShow: (channelId?: string): Promise<BlockedReason | null> =>
    NativeNotifications.canShow(channelId ? { channelId } : {}, unowned).then(
      (r) => r.reason,
      (): BlockedReason => "off",
    ),

  /** Shows it, or says why not (`shown: false` with the reason). */
  show: (options: ShowOptions): Promise<{ shown: boolean; reason: BlockedReason | null }> =>
    NativeNotifications.show(options, unowned).catch(() => ({ shown: false, reason: "off" as BlockedReason })),

  cancel: (id: string): Promise<boolean> => NativeNotifications.cancel({ id }, unowned).catch(no),
  /** All of the app's notifications (on logout). */
  cancelAll: (): Promise<boolean> => NativeNotifications.cancelAll({}, unowned).catch(no),

  /** A notification swiped away, with its `data`. Call it once, at the top of main.ts. */
  onDismiss: (handler: (event: { id: string; data: Record<string, string> }, signal: AbortSignal) => unknown): void =>
    defineTask(DISMISS_TASK, handler),
}

/** RN Firebase's names, for code that ports over: `messaging().getToken()`. */
export const messaging = () => ({
  getToken: () => Push.getToken().then((r) => r.token ?? ""),
  deleteToken: () => Push.deleteToken().then(() => undefined),
  subscribeToTopic: (topic: string) => Push.subscribe(topic).then(() => undefined),
  unsubscribeFromTopic: (topic: string) => Push.unsubscribe(topic).then(() => undefined),
  onTokenRefresh: (fn: (token: string) => unknown) => Push.onTokenRefresh(({ token }) => fn(token)),
  setBackgroundMessageHandler: (fn: (message: PushMessage) => Promise<unknown>) => Push.onMessage((m) => fn(m)),
})
