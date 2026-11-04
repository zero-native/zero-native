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
import { defineTask, nativeModule, Permissions, type CallOptions, type PermissionState } from "@zero-native/core"

/** Core task names the native side runs (PushRules.kt). */
export const MESSAGE_TASK = "push.message"
export const TOKEN_TASK = "push.token"
export const DISMISS_TASK = "push.dismissed"
export const ACTION_TASK = "push.action"

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
  /** A channel group's id (`createChannelGroup`): a heading over channels in the phone's settings. */
  groupId?: string
}

/** A channel as the user left it (they can change its importance, or turn it off). */
export interface ChannelInfo {
  id: string
  name: string
  importance: Importance
  /** The user turned it off. */
  blocked: boolean
  description: string | null
  groupId: string | null
}

/** A button on a notification. Android shows 3 at most. */
export interface NotificationAction {
  /** Yours: given back to `onAction`. */
  id: string
  title: string
  /** Opens like a tap on the notification. Without it, the button runs `onAction` with no screen. */
  link?: string
  /** The user types a reply in the notification first (Android's inline reply); `onAction` gets `input`. */
  input?: { placeholder?: string }
}

/** What the lock screen shows: "private" (default) hides the text, "secret" the whole notification. */
export type Visibility = "public" | "private" | "secret"

/** Android ranks and filters by it (Do Not Disturb lets some through). */
export type Category =
  | "message" | "reminder" | "status" | "progress" | "promo" | "transport" | "event" | "social" | "error" | "recommendation" | "service"

/** A notification on screen now (`getDisplayed`). */
export interface DisplayedNotification {
  id: string
  title: string | null
  body: string | null
  channelId: string | null
  group: string | null
  /** ms since 1970. */
  shownAt: number
  data: Record<string, string>
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
  /** Buttons (3 at most). Native version 2. */
  actions?: NotificationAction[]
  /** Inbox style: up to 6 short lines when expanded ("₹499 from Ravi", "₹120 from Asha"). A picture wins over it. */
  lines?: string[]
  /** A progress bar: `current` of `max`, or `indeterminate`. Update it by showing the same id again with `onlyAlertOnce`. */
  progress?: { max?: number; current?: number; indeterminate?: boolean }
  /** The user can't swipe it away (a running upload). Cancel it yourself. */
  ongoing?: boolean
  /** Sound and vibration only the first time this id shows, not on updates. */
  onlyAlertOnce?: boolean
  /** No sound or vibration at all. */
  silent?: boolean
  /** The count on the app icon's badge (launchers that show counts). */
  number?: number
  /** The time shown, ms since 1970 (default: when it was shown). */
  timestamp?: number
  showTimestamp?: boolean
  /** Default "private": the lock screen shows only the app name. Use "secret" for anything about money. */
  visibility?: Visibility
  category?: Category
  /** "#RRGGBB": the accent colour (the icon and buttons). Default: the manifest's `dev.zeronative.push.color`. */
  color?: string
}

/** When a scheduled notification shows (notifee's timestamp trigger). */
export interface Trigger {
  /** ms since 1970. For a repeat, the first time. */
  at: number
  /** Then every hour, day or week (fixed lengths). */
  repeat?: "hourly" | "daily" | "weekly"
  /**
   * At the exact time even in Doze. Needs the app's own `SCHEDULE_EXACT_ALARM` permission and the user's yes on Android
   * 12+ (`canScheduleExact`); else it shows within 10 minutes (in deep Doze: when the phone wakes). Default false.
   */
  exact?: boolean
}

/** Why `schedule` didn't: a one-time `at` that has passed, a bad `repeat`, or no id. */
export type ScheduleReason = "past" | "bad_repeat" | "no_id"

export type SettingsPage = "exact_alarms" | "battery" | "notifications"

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
  getInitialNotification(args?: Record<string, never>, options?: CallOptions): Promise<OpenedMessage | null>
  setAutoInitEnabled(args: { on: boolean }, options?: CallOptions): Promise<boolean>
  isAutoInitEnabled(args?: Record<string, never>, options?: CallOptions): Promise<boolean>
  events: { opened: OpenedMessage }
}

export interface NotificationsModule {
  createChannel(args: Channel, options?: CallOptions): Promise<boolean>
  deleteChannel(args: { id: string }, options?: CallOptions): Promise<boolean>
  canShow(args: { channelId?: string }, options?: CallOptions): Promise<{ reason: BlockedReason | null }>
  show(args: ShowOptions, options?: CallOptions): Promise<{ shown: boolean; reason: BlockedReason | null }>
  cancel(args: { id: string }, options?: CallOptions): Promise<boolean>
  cancelAll(args?: Record<string, never>, options?: CallOptions): Promise<boolean>
  createChannelGroup(args: { id: string; name: string; description?: string }, options?: CallOptions): Promise<boolean>
  deleteChannelGroup(args: { id: string }, options?: CallOptions): Promise<boolean>
  getChannels(args?: Record<string, never>, options?: CallOptions): Promise<ChannelInfo[]>
  getChannel(args: { id: string }, options?: CallOptions): Promise<ChannelInfo | null>
  getDisplayed(args?: Record<string, never>, options?: CallOptions): Promise<DisplayedNotification[]>
  schedule(args: { notification: ShowOptions } & Trigger, options?: CallOptions): Promise<{ scheduled: boolean; reason: ScheduleReason | null }>
  getScheduled(args?: Record<string, never>, options?: CallOptions): Promise<{ id: string; at: number; repeat: Trigger["repeat"] | null }[]>
  canScheduleExact(args?: Record<string, never>, options?: CallOptions): Promise<boolean>
  isBatteryOptimized(args?: Record<string, never>, options?: CallOptions): Promise<boolean>
  openSettings(args: { page: SettingsPage }, options?: CallOptions): Promise<boolean>
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

  /** Android 13+ asks (from a tap: "Turn on notifications"); older Android: granted. Core's Permissions. */
  requestPermission: (): Promise<PermissionState> =>
    Permissions.request(["notifications"]).then((r) => r.notifications, (): PermissionState => "denied"),
  hasPermission: (): Promise<PermissionState> =>
    Permissions.status(["notifications"]).then((r) => r.notifications, (): PermissionState => "denied"),
}

/** RN Firebase's `messaging.AuthorizationStatus`, for code that ports over. Android has no "provisional". */
export const AuthorizationStatus = { NOT_DETERMINED: -1, DENIED: 0, AUTHORIZED: 1, PROVISIONAL: 2 } as const
const authorization = (s: PermissionState) => (s === "granted" ? AuthorizationStatus.AUTHORIZED : AuthorizationStatus.DENIED)

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

  /**
   * A button with no `link` pressed, with the notification's `data` and the typed `input` of a reply button. Runs with
   * no screen, 8 s at most. Call it once, at the top of main.ts. The notification stays: cancel it, or show the same
   * id again (Android shows a spinner after a reply until you do). Native version 2.
   */
  onAction: (
    handler: (event: { id: string; actionId: string; data: Record<string, string>; input?: string }, signal: AbortSignal) => unknown,
  ): void => defineTask(ACTION_TASK, handler),

  /** A heading over channels in the phone's settings. Android 8+. Native version 2. */
  createChannelGroup: (group: { id: string; name: string; description?: string }): Promise<boolean> =>
    NativeNotifications.createChannelGroup(group, unowned).catch(no),
  deleteChannelGroup: (id: string): Promise<boolean> => NativeNotifications.deleteChannelGroup({ id }, unowned).catch(no),

  /** The app's channels as the user left them. Empty below Android 8 (or with an older app). Native version 2. */
  getChannels: (): Promise<ChannelInfo[]> => NativeNotifications.getChannels({}, unowned).catch(() => []),
  getChannel: (id: string): Promise<ChannelInfo | null> => NativeNotifications.getChannel({ id }, unowned).catch(() => null),

  /** The app's notifications on screen now, newest first (group summaries left out). Native version 2. */
  getDisplayed: (): Promise<DisplayedNotification[]> => NativeNotifications.getDisplayed({}, unowned).catch(() => []),

  /**
   * Shows it later, natively, with no JS (notifee's `createTriggerNotification`). The same id replaces an earlier one;
   * `cancel(id)` removes it. It survives the app being closed; after a reboot only with the boot receiver (README).
   * Native version 2.
   */
  schedule: (notification: ShowOptions, trigger: Trigger): Promise<{ scheduled: boolean; reason: ScheduleReason | null }> =>
    NativeNotifications.schedule({ notification, ...trigger }, unowned).catch(() => ({ scheduled: false, reason: null })),

  /** The scheduled ones, soonest first: `[{ id, at, repeat }]`. */
  getScheduled: (): Promise<{ id: string; at: number; repeat: Trigger["repeat"] | null }[]> =>
    NativeNotifications.getScheduled({}, unowned).catch(() => []),

  /** Exact alarms are allowed (always below Android 12). */
  canScheduleExact: (): Promise<boolean> => NativeNotifications.canScheduleExact({}, unowned).catch(no),

  /** Android may hold the app's alarms and background work back (the default). Phones like Xiaomi add their own rules. */
  isBatteryOptimized: (): Promise<boolean> => NativeNotifications.isBatteryOptimized({}, unowned).catch(no),

  /** Opens a settings page for the user: exact alarms (Android 12+), battery optimisation, or the app's notifications. */
  openSettings: (page: SettingsPage): Promise<boolean> => NativeNotifications.openSettings({ page }, unowned).catch(no),
}

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
  requestPermission: () => Push.requestPermission().then(authorization),
  hasPermission: () => Push.hasPermission().then(authorization),
})
