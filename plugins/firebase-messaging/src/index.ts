// The push plugin's JS side: Firebase Cloud Messaging. Native side: android/.../PushPlugin.kt. Notifications the app
// shows itself are @zero-native/notifications (re-exported here, so old imports keep working).
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
// On a tap ("Turn on notifications"): `Push.requestPermission()` (the same as `Notifications.requestPermission()`).
// Each call answers with a value and never rejects. With no Firebase (no google-services.json) Push says
// `available: false`; Notifications still work.
import { nativeModule, type CallOptions, type PermissionState } from "@zero-native/core"
import { Notifications, PushEvents, type IosPermissionOptions, type PushMessage } from "@zero-native/notifications"

// Moved to @zero-native/notifications (2026-11-09): Notifications, PushEvents, their types and task names. Import them
// from there in new code; this keeps old imports from "@zero-native/firebase-messaging" working.
export * from "@zero-native/notifications"

/** A tap on a notification FCM showed itself (a message with a `notification` block, app behind or closed). */
export interface OpenedMessage {
  messageId: string
  from: string | null
  sentAt: number
  /** The message's data, all strings. Put a `link` in it and open it yourself (README). */
  data: Record<string, string>
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

export interface PushModule {
  status(args?: Record<string, never>, options?: CallOptions): Promise<{ available: boolean }>
  getToken(args?: Record<string, never>, options?: CallOptions): Promise<TokenResult>
  deleteToken(args?: Record<string, never>, options?: CallOptions): Promise<boolean>
  subscribe(args: { topic: string }, options?: CallOptions): Promise<boolean>
  unsubscribe(args: { topic: string }, options?: CallOptions): Promise<boolean>
  getInitialNotification(args?: Record<string, never>, options?: CallOptions): Promise<OpenedMessage | null>
  setAutoInitEnabled(args: { on: boolean }, options?: CallOptions): Promise<boolean>
  isAutoInitEnabled(args?: Record<string, never>, options?: CallOptions): Promise<boolean>
  events: { opened: OpenedMessage }
}

const NativePush = nativeModule<PushModule>("FirebaseMessaging", { version: 1 })
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
  onMessage: (handler: (message: PushMessage, signal: AbortSignal) => unknown): void => PushEvents.onMessage(handler),

  /** A new token, also while the app was closed. Call it once, at the top of main.ts. */
  onTokenRefresh: (handler: (event: { token: string }, signal: AbortSignal) => unknown): void => PushEvents.onTokenRefresh(handler),

  /**
   * The FCM notification whose tap started the app (it was closed), once; null otherwise. Notifications the app
   * shows itself (`Notifications.show`) open their `link` instead. Native version 2.
   */
  getInitialNotification: (): Promise<OpenedMessage | null> => NativePush.getInitialNotification({}, unowned).catch(() => null),

  /** A tap on an FCM notification while the app runs behind. Returns the unsubscribe function. Native version 2. */
  onNotificationOpenedApp: (handler: (message: OpenedMessage) => void): (() => void) => NativePush.on("opened", handler),

  /** FCM's token at the first start, by itself. Off: no token until `getToken()`. Kept across starts. Native version 2. */
  setAutoInitEnabled: (on: boolean): Promise<boolean> => NativePush.setAutoInitEnabled({ on }, unowned).catch(no),
  isAutoInitEnabled: (): Promise<boolean> => NativePush.isAutoInitEnabled({}, unowned).catch(no),

  /**
   * Android 13+ asks (from a tap: "Turn on notifications"); older Android: granted. iOS asks once, or with [options]
   * (provisional: no dialog). The same as Notifications'.
   */
  requestPermission: (options?: { ios?: IosPermissionOptions }): Promise<PermissionState> => Notifications.requestPermission(options),
  hasPermission: (): Promise<PermissionState> => Notifications.hasPermission(),
}

/** RN Firebase's `messaging.AuthorizationStatus`, for code that ports over. Only iOS has "provisional". */
export const AuthorizationStatus = { NOT_DETERMINED: -1, DENIED: 0, AUTHORIZED: 1, PROVISIONAL: 2 } as const
const authorization = (s: PermissionState) => (s === "granted" ? AuthorizationStatus.AUTHORIZED : AuthorizationStatus.DENIED)

/** RN Firebase's names, for code that ports over: `messaging().getToken()`. */
export const messaging = () => ({
  getToken: () => Push.getToken().then((r) => r.token ?? ""),
  deleteToken: () => Push.deleteToken().then(() => undefined),
  subscribeToTopic: (topic: string) => Push.subscribe(topic).then(() => undefined),
  unsubscribeFromTopic: (topic: string) => Push.unsubscribe(topic).then(() => undefined),
  onTokenRefresh: (fn: (token: string) => unknown) => Push.onTokenRefresh(({ token }) => fn(token)),
  setBackgroundMessageHandler: (fn: (message: PushMessage) => Promise<unknown>) => Push.onMessage((m) => fn(m)),
  getInitialNotification: () => Push.getInitialNotification(),
  onNotificationOpenedApp: (fn: (message: OpenedMessage) => void) => Push.onNotificationOpenedApp(fn),
  setAutoInitEnabled: (on: boolean) => Push.setAutoInitEnabled(on).then(() => undefined),
  requestPermission: (ios?: IosPermissionOptions) => Push.requestPermission(ios ? { ios } : undefined).then(authorization),
  hasPermission: () => Push.hasPermission().then(authorization),
})
