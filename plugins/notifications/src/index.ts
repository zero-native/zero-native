// The notifications plugin's JS side. Native side: android/.../NotificationsPlugin.kt (NotificationCompat; no Firebase) and
// ios/NotificationsPlugin.swift (UNUserNotificationCenter). Options as notifee's: shared fields, then `android: {...}` and
// `ios: {...}` (docs/ios-notifications-plan.md). Android-only calls answer harmlessly on iOS, and iOS-only ones on Android.
//
// At start (safe every time):
//
//   await Notifications.createChannel({ id: "offers", name: "Offers", importance: "high" })
//   await Notifications.show({ id: "offer-12", channelId: "offers", title: "10% off", link: "myapp://offers/12" })
//
// At the top of main.ts (they run with no screen, so they must be there before any screen):
//
//   Notifications.onDismiss(({ id, data }) => ...)
//   Notifications.onAction(({ id, actionId, input }) => ...)
//   PushEvents.onMessage(async (m, signal) => ...)          // messages from any push service (FCM: plugins/firebase-messaging)
//
// On a tap ("Turn on notifications"): `Notifications.requestPermission()` (Android 13+ asks; older: on).
// A tap on a notification opens its `link` through the app's normal link path (`onLink` in startApp).
// Each call answers with a value and never rejects.
import { defineTask, nativeModule, Permissions, Platform, type CallOptions, type PermissionState } from "@zeronative/core"

/** Core task names the native side runs (PushEvents.kt, NotificationRules.kt). */
export const MESSAGE_TASK = "push.message"
export const TOKEN_TASK = "push.token"
export const DISMISS_TASK = "push.dismissed"
export const ACTION_TASK = "push.action"

/** A message from a push service (FCM: plugins/firebase-messaging), the same shape from every service (PushEvents.kt). */
export interface PushMessage {
  /** The push service: "fcm" (plugins/firebase-messaging). Missing from apps built before the notifications plugin (2026-11-09). */
  provider?: string
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
  /** The message's data, all strings (every service gives strings). Never log it as a whole: it may hold anything. */
  data: Record<string, string>
  /** The `notification` block, if the server sent one. Android shows such a message itself while the app is behind. */
  notification: { title: string | null; body: string | null } | null
  /** True once: the service dropped messages it couldn't deliver (offline too long). Sync with your server instead. */
  deleted?: boolean
  /**
   * iOS: the phone showed this push itself (the server's `apns` alert) while the app was behind or closed; it reaches JS
   * at the next start or return to the front, or with its tap, swipe or button (once per message id). Don't show it
   * again: save it, count it. Every one with an App Group (the service extension notes it); without one, only the ones
   * still in the notification centre or acted on.
   */
  shown?: boolean
  /** With `shown`: when iOS showed it, ms since 1970. */
  shownAt?: number
}

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
  input?: { placeholder?: string; buttonTitle?: string }
  /** iOS only: `foreground` opens the app first; `destructive` shows it red; `authenticationRequired` needs an unlocked phone. */
  ios?: { foreground?: boolean; destructive?: boolean; authenticationRequired?: boolean }
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

/** Android's own options (notifee's `android: {...}`). On iOS they are ignored. */
export interface AndroidShowOptions {
  /** Needed on Android 8+: a channel made with `createChannel`. */
  channelId?: string
  /** The text when expanded. Without it, a body longer than ~40 characters expands by itself. */
  bigText?: string
  /** https only (http also in debug builds). Downloaded natively in at most 4 s, else left out. */
  largeIconUrl?: string
  /** Removed when tapped. Default true. */
  autoCancel?: boolean
  /** Inbox style: up to 6 short lines when expanded ("₹499 from Ravi", "₹120 from Asha"). A picture wins over it. */
  lines?: string[]
  /** A progress bar: `current` of `max`, or `indeterminate`. Update it by showing the same id again with `onlyAlertOnce`. */
  progress?: { max?: number; current?: number; indeterminate?: boolean }
  /** The user can't swipe it away (a running upload). Cancel it yourself. */
  ongoing?: boolean
  /** Sound and vibration only the first time this id shows, not on updates. */
  onlyAlertOnce?: boolean
  /** The count on the app icon's badge (launchers that show counts). */
  number?: number
  /** The time shown, ms since 1970 (default: when it was shown). */
  timestamp?: number
  showTimestamp?: boolean
  /** Default "private": the lock screen shows only the app name. Use "secret" for anything about money. */
  visibility?: Visibility
  category?: Category
  /** "#RRGGBB": the accent colour (the icon and buttons). Default: the manifest's `dev.zeronative.notifications.color`. */
  color?: string
}

/** How iOS may interrupt: "passive" stays quiet, "timeSensitive" breaks through Focus (the app's capability), "critical" needs Apple's entitlement. */
export type IosInterruptionLevel = "passive" | "active" | "timeSensitive" | "critical"

/** What iOS shows while the app is in front. Default: banner, list, sound and badge. */
export interface IosForegroundPresentation {
  banner?: boolean
  list?: boolean
  sound?: boolean
  badge?: boolean
}

/** A picture (or other media) shown in the notification: https, `asset:<path>` or `zn://file/<name>`. Downloaded natively in at most 4 s. */
export interface IosAttachment {
  url: string
  id?: string
  /** Hide the small picture on the right; it shows when expanded. */
  thumbnailHidden?: boolean
}

/** iOS's own options (notifee's `ios: {...}`). On Android they are ignored. */
export interface IosShowOptions {
  /** A second line under the title. */
  subtitle?: string
  /** Notifications with the same thread id are grouped. Default: `group.key`. */
  threadId?: string
  /** A category set with `setNotificationCategories` (its buttons). Default: one made for `actions`. */
  categoryId?: string
  /** "default" (the default), a sound file in the app, or false for none. `silent: true` means false. */
  sound?: string | false
  /** The app icon's badge after this one shows. */
  badgeCount?: number
  interruptionLevel?: IosInterruptionLevel
  /** 0 to 1: which one leads its group and the notification summary. */
  relevanceScore?: number
  /** Fills the category's `summaryFormat` ("%u more offers from %@"). */
  summaryArgument?: string
  summaryArgumentCount?: number
  /** Media shown in it. `imageUrl` adds one picture by itself. */
  attachments?: IosAttachment[]
  foregroundPresentationOptions?: IosForegroundPresentation
}

export interface ShowOptions {
  /** Yours. Showing the same id again replaces it. */
  id: string
  /**
   * Title, body, bigText and lines may be HTML, as in notifee: `<b>`, `<i>`, `<u>`, `<span style="color:#E23744">`.
   * Text with no tag stays exactly as given. Native version 3 (older apps show the tags as text). iOS has no rich
   * text: it shows the text with the tags taken out.
   */
  title: string
  body?: string
  /**
   * Opened on a tap, through the app's link path. Another app's or a web link opens there. None: the app opens, and
   * `Notifications.onPress` hears it with the `id` and `data`.
   */
  link?: string
  /** A big picture when expanded (iOS: an attachment). https only (http also in debug builds); at most 4 s to download. */
  imageUrl?: string
  /**
   * Notifications with the same key are grouped. From 2 on, a summary shows (the newest 5 lines). A tap on the
   * summary opens its `link`; with none, `onPress` hears `{ id: key, data }` (native version 3). iOS groups by it
   * (its thread id) and shows its own summary.
   */
  group?: { key: string; title?: string; summaryFormat?: string; link?: string; data?: Record<string, string> }
  /** Strings given back to `onPress`, `onDismiss` and `onAction`. */
  data?: Record<string, string>
  /** Buttons (Android 3 at most, iOS 4). Native version 2. */
  actions?: NotificationAction[]
  /** No sound or vibration at all. */
  silent?: boolean
  android?: AndroidShowOptions
  ios?: IosShowOptions

  /** @deprecated Use `android.channelId`. */
  channelId?: string
  /** @deprecated Use `android.bigText`. */
  bigText?: string
  /** @deprecated Use `android.largeIconUrl`. */
  largeIconUrl?: string
  /** @deprecated Use `android.autoCancel`. */
  autoCancel?: boolean
  /** @deprecated Use `android.lines`. */
  lines?: string[]
  /** @deprecated Use `android.progress`. */
  progress?: { max?: number; current?: number; indeterminate?: boolean }
  /** @deprecated Use `android.ongoing`. */
  ongoing?: boolean
  /** @deprecated Use `android.onlyAlertOnce`. */
  onlyAlertOnce?: boolean
  /** @deprecated Use `android.number` (iOS: `ios.badgeCount`). */
  number?: number
  /** @deprecated Use `android.timestamp`. */
  timestamp?: number
  /** @deprecated Use `android.showTimestamp`. */
  showTimestamp?: boolean
  /** @deprecated Use `android.visibility`. */
  visibility?: Visibility
  /** @deprecated Use `android.category`. */
  category?: Category
  /** @deprecated Use `android.color`. */
  color?: string
}

/**
 * What the native side gets: the shared fields with Android's options flat (as every Android app has read them since
 * native version 1: Kotlin is unchanged), and `ios` as it is. Android ignores `ios`; iOS ignores Android's fields.
 */
export function nativeShowArgs(options: ShowOptions): Record<string, unknown> {
  const { android, ios, ...rest } = options
  return { ...rest, ...(android ?? {}), ...(ios ? { ios } : {}) }
}

/** A set of buttons iOS shows on notifications with this category id (notifee's `setNotificationCategories`). */
export interface IosCategory {
  id: string
  actions?: NotificationAction[]
  /** The group's summary, "%u more offers" (`%u` the count, `%@` the summaryArgument). */
  summaryFormat?: string
  /** What a hidden preview says ("New offer"). */
  hiddenPreviewsBodyPlaceholder?: string
  /** Swiping it away runs `onDismiss`. Default true. */
  customDismissAction?: boolean
}

/** What iOS may ask for (notifee's `requestPermission({ ... })`). Default: alert, badge, sound. */
export interface IosPermissionOptions {
  alert?: boolean
  badge?: boolean
  sound?: boolean
  /** Shown quietly in the notification centre with no dialog; the user decides there. */
  provisional?: boolean
  /** Needs Apple's critical alerts entitlement. */
  criticalAlert?: boolean
  carPlay?: boolean
  /** A "Notification settings" button in the phone's settings for the app (the app gets `openSettings`). */
  providesAppNotificationSettings?: boolean
}

/** notifee's `AuthorizationStatus` names. */
export type AuthorizationStatus = "notDetermined" | "denied" | "authorized" | "provisional" | "ephemeral"

export interface NotificationSettings {
  authorizationStatus: AuthorizationStatus
  /** iOS only: what the user left on. */
  ios?: { alert: boolean; badge: boolean; sound: boolean; lockScreen: boolean; notificationCenter: boolean; criticalAlert: boolean; carPlay: boolean }
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

/** A tap on one of the app's own notifications that had no `link` (notifee's PRESS event). Native version 3. */
export interface PressedNotification {
  /** The `id` it was shown with. */
  id: string
  /** Its `data`. */
  data: Record<string, string>
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
  getInitialNotification(args?: Record<string, never>, options?: CallOptions): Promise<PressedNotification | null>
  // iOS only (Android's module doesn't have them: the calls answer false / 0 / [] there)
  requestPermission(args: { ios: IosPermissionOptions }, options?: CallOptions): Promise<PermissionState>
  getNotificationSettings(args?: Record<string, never>, options?: CallOptions): Promise<NotificationSettings>
  setBadgeCount(args: { count: number }, options?: CallOptions): Promise<boolean>
  getBadgeCount(args?: Record<string, never>, options?: CallOptions): Promise<number>
  setNotificationCategories(args: { categories: IosCategory[] }, options?: CallOptions): Promise<boolean>
  getNotificationCategories(args?: Record<string, never>, options?: CallOptions): Promise<IosCategory[]>
  events: { pressed: PressedNotification }
}

const NativeNotifications = nativeModule<NotificationsModule>("Notifications", { version: 1 })
// Not tied to a screen: a task has no screen, and a token sync must not stop because a screen closed.
const unowned = { owned: false }
const no = () => false

/**
 * Messages and tokens from any push service (FCM: plugins/firebase-messaging; later APNs or another service), as JS tasks. The
 * service's own plugin gets them; this is where JS hears them. Call each once, at the top of main.ts.
 */
export const PushEvents = {
  /**
   * Every data message, in front, behind or closed (RN Firebase's onMessage and setBackgroundMessageHandler in one).
   * [handler] has 15 s; `signal` aborts at the limit.
   */
  onMessage: (handler: (message: PushMessage, signal: AbortSignal) => unknown): void => defineTask<PushMessage>(MESSAGE_TASK, handler),

  /** A new token, also while the app was closed. `provider` is missing from apps built before 2026-11-09. */
  onTokenRefresh: (handler: (event: { token: string; provider?: string }, signal: AbortSignal) => unknown): void =>
    defineTask(TOKEN_TASK, handler),
}

export const Notifications = {
  /**
   * Android 13+ asks (from a tap: "Turn on notifications"); older Android: granted. iOS asks once (alert, badge, sound),
   * or with [options].ios (provisional: no dialog). Core's Permissions.
   */
  requestPermission: (options?: { ios?: IosPermissionOptions }): Promise<PermissionState> => {
    const viaCore = () => Permissions.request(["notifications"]).then((r) => r.notifications, (): PermissionState => "denied")
    if (options?.ios && Platform.OS === "ios") return NativeNotifications.requestPermission({ ios: options.ios }, unowned).catch(viaCore)
    return viaCore()
  },
  hasPermission: (): Promise<PermissionState> =>
    Permissions.status(["notifications"]).then((r) => r.notifications, (): PermissionState => "denied"),

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
    NativeNotifications.show(nativeShowArgs(options) as unknown as ShowOptions, unowned).catch(() => ({ shown: false, reason: "off" as BlockedReason })),

  cancel: (id: string): Promise<boolean> => NativeNotifications.cancel({ id }, unowned).catch(no),
  /** All of the app's notifications (on logout). */
  cancelAll: (): Promise<boolean> => NativeNotifications.cancelAll({}, unowned).catch(no),

  /**
   * A notification swiped away, with its `data`. Call it once, at the top of main.ts. iOS also gives it for a push the
   * phone showed itself (its category has the dismiss action; the service extension gives `zn.default`): then `id` is
   * the message id and `provider` is set ("fcm"). Android doesn't for pushes FCM shows itself.
   */
  onDismiss: (handler: (event: { id: string; data: Record<string, string>; provider?: string }, signal: AbortSignal) => unknown): void =>
    defineTask(DISMISS_TASK, handler),

  /**
   * A button with no `link` pressed, with the notification's `data` and the typed `input` of a reply button. Runs with
   * no screen, 8 s at most. Call it once, at the top of main.ts. The notification stays: cancel it, or show the same
   * id again (Android shows a spinner after a reply until you do). Native version 2. iOS also gives it for a button
   * on a push the phone showed (the server's `aps.category`, one set with `setNotificationCategories`): then `id` is the
   * message id and `provider` is set ("fcm").
   */
  onAction: (
    handler: (
      event: { id: string; actionId: string; data: Record<string, string>; input?: string; provider?: string },
      signal: AbortSignal,
    ) => unknown,
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
    NativeNotifications.schedule({ notification: nativeShowArgs(notification) as unknown as ShowOptions, ...trigger }, unowned).catch(() => ({
      scheduled: false,
      reason: null,
    })),

  /** The scheduled ones, soonest first: `[{ id, at, repeat }]`. */
  getScheduled: (): Promise<{ id: string; at: number; repeat: Trigger["repeat"] | null }[]> =>
    NativeNotifications.getScheduled({}, unowned).catch(() => []),

  /** Exact alarms are allowed (always below Android 12). */
  canScheduleExact: (): Promise<boolean> => NativeNotifications.canScheduleExact({}, unowned).catch(no),

  /** Android may hold the app's alarms and background work back (the default). Phones like Xiaomi add their own rules. */
  isBatteryOptimized: (): Promise<boolean> => NativeNotifications.isBatteryOptimized({}, unowned).catch(no),

  /** Opens a settings page for the user: exact alarms (Android 12+), battery optimisation, or the app's notifications. */
  openSettings: (page: SettingsPage): Promise<boolean> => NativeNotifications.openSettings({ page }, unowned).catch(no),

  /**
   * The app's own notification (no `link`) whose tap started the app, once; null otherwise (notifee's
   * `getInitialNotification`). A push service's own: its plugin (FCM: `Push.getInitialNotification`). Native version 3.
   */
  getInitialNotification: (): Promise<PressedNotification | null> =>
    NativeNotifications.getInitialNotification({}, unowned).catch(() => null),

  /**
   * A tap on one of the app's own notifications with no `link`, while the app runs (notifee's PRESS event), with its
   * `id` and `data`. A notification with a `link` opens the link instead. Returns the unsubscribe function. Native
   * version 3.
   */
  onPress: (handler: (notification: PressedNotification) => void): (() => void) => NativeNotifications.on("pressed", handler),

  /**
   * notifee's settings: `authorizationStatus`, and on iOS what the user left on. Android: "authorized" or "denied" from
   * the permission.
   */
  getNotificationSettings: (): Promise<NotificationSettings> =>
    NativeNotifications.getNotificationSettings({}, unowned).catch(() =>
      Notifications.hasPermission().then((s): NotificationSettings => ({ authorizationStatus: s === "granted" ? "authorized" : "denied" })),
    ),

  /** iOS: the number on the app icon (0 hides it). Android: false (launchers count notifications themselves; `android.number`). */
  setBadgeCount: (count: number): Promise<boolean> => NativeNotifications.setBadgeCount({ count: Math.max(0, Math.trunc(count)) }, unowned).catch(no),
  /** iOS: the number on the app icon. Android: 0. */
  getBadgeCount: (): Promise<number> => NativeNotifications.getBadgeCount({}, unowned).catch(() => 0),
  incrementBadgeCount: (by = 1): Promise<boolean> =>
    Notifications.getBadgeCount().then((n) => Notifications.setBadgeCount(n + by)),
  decrementBadgeCount: (by = 1): Promise<boolean> =>
    Notifications.getBadgeCount().then((n) => Notifications.setBadgeCount(Math.max(0, n - by))),

  /**
   * iOS: the app's categories (buttons for `ios.categoryId`, group summaries). Replaces the ones set before; the ones
   * `show` makes for its `actions` are kept. Android: false (buttons come with each notification).
   */
  setNotificationCategories: (categories: IosCategory[]): Promise<boolean> =>
    NativeNotifications.setNotificationCategories({ categories }, unowned).catch(no),
  getNotificationCategories: (): Promise<IosCategory[]> => NativeNotifications.getNotificationCategories({}, unowned).catch(() => []),
}
