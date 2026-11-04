// The Analytics plugin's JS side (RN Firebase's `analytics()`). Native side: android/.../AnalyticsPlugin.kt.
//
// Analytics is OFF until the app turns it on, after the user agrees:
//
//   await Analytics.setAnalyticsCollectionEnabled(true)        // Firebase keeps it across starts
//   Analytics.logEvent("pay_tapped", { amount: 499, method: "upi" })
//   Analytics.logPurchase({ value: 499, currency: "INR", transaction_id: txnId })
//   Analytics.setUserId(customerCode)                          // an id of yours. Never a phone number or an email
//
// Screen views are sent by themselves, one per top route (the route's name). Every event carries `zn_bundle`, the
// running bundle. Each call answers and never rejects. A bad name (Analytics' rules: letters, digits and _, 40
// characters, no `firebase_` / `google_` / `ga_` start) answers false with a console warning, and nothing is sent.
// With no Firebase in the app every call does nothing, and `status()` says `available: false`.
import { nativeModule, type CallOptions } from "@zero-native/core"

/** What a parameter can be. Booleans are sent as 1 or 0 (Analytics has none); strings are cut to 100 characters. */
export type ParamValue = string | number | boolean | null | undefined
/** One e-commerce item (`items`): item_id, item_name, price, quantity, ... */
export type Item = Record<string, ParamValue>
export type Params = Record<string, ParamValue | Item[]>

/** Consent mode v2, RN Firebase's names. A key left out is not changed. */
export interface Consent {
  analytics_storage?: boolean
  ad_storage?: boolean
  ad_user_data?: boolean
  ad_personalization?: boolean
}

export interface AnalyticsStatus {
  /** False: Firebase isn't set up in this app (no google-services.json), or the plugin is missing. */
  available: boolean
}

export interface AnalyticsModule {
  status(args?: Record<string, never>, options?: CallOptions): Promise<AnalyticsStatus>
  setCollectionEnabled(args: { on: boolean }, options?: CallOptions): Promise<boolean>
  setConsent(
    args: { analyticsStorage?: boolean; adStorage?: boolean; adUserData?: boolean; adPersonalization?: boolean },
    options?: CallOptions,
  ): Promise<boolean>
  /** "" when sent, else why not. */
  logEvent(args: { name: string; params?: Params }, options?: CallOptions): Promise<string>
  setUserId(args: { id: string | null }, options?: CallOptions): Promise<string>
  setUserProperty(args: { name: string; value: string | null }, options?: CallOptions): Promise<string>
  setUserProperties(args: { values: Record<string, string | null> }, options?: CallOptions): Promise<string>
  setDefaultEventParameters(args: { params: Record<string, ParamValue> | null }, options?: CallOptions): Promise<string>
  getAppInstanceId(args?: Record<string, never>, options?: CallOptions): Promise<string | null>
  resetAnalyticsData(args?: Record<string, never>, options?: CallOptions): Promise<boolean>
  setSessionTimeoutDuration(args: { ms: number }, options?: CallOptions): Promise<boolean>
}

const Native = nativeModule<AnalyticsModule>("Analytics", { version: 1 })
// Not tied to a screen: an event must not be cancelled because the screen that sent it closed.
const unowned = { owned: false }

/** Native's answer "" means sent; anything else is the reason it wasn't (a console warning for the author). */
function sent(p: Promise<string>): Promise<boolean> {
  return p.then(
    (problem) => {
      if (problem) console.warn(`analytics: ${problem}`)
      return !problem
    },
    () => false,
  )
}

const quietly = (p: Promise<boolean>) => p.catch(() => false)

/** Leaves out undefined values: they would reach native as missing keys anyway, but this keeps `params` plain. */
function clean<T extends Record<string, unknown>>(o: T | undefined): T | undefined {
  if (!o) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v
  return out as T
}

const logEvent = (name: string, params?: Params): Promise<boolean> =>
  sent(Native.logEvent({ name, ...(params ? { params: clean(params) } : {}) }, unowned))

/** Google's recommended events, with RN Firebase's names. Each is `logEvent(<name>, params)`. */
const recommended = <P extends Params>(name: string) => (params?: P) => logEvent(name, params)

export interface PurchaseParams extends Params {
  value?: number
  currency?: string
  transaction_id?: string
  coupon?: string
  items?: Item[]
}

export const Analytics = {
  /** `{ available }`. No dialog, no network. */
  status: (): Promise<AnalyticsStatus> => Native.status({}, unowned).catch(() => ({ available: false })),

  /** On after the user agrees, off when they opt out. Firebase keeps it across starts. Starts off (README). */
  setAnalyticsCollectionEnabled: (on: boolean): Promise<boolean> => quietly(Native.setCollectionEnabled({ on }, unowned)),

  /** Consent mode: what Google may store and use. Keys left out are not changed. */
  setConsent: (c: Consent): Promise<boolean> =>
    quietly(
      Native.setConsent(
        clean({
          analyticsStorage: c.analytics_storage,
          adStorage: c.ad_storage,
          adUserData: c.ad_user_data,
          adPersonalization: c.ad_personalization,
        })!,
        unowned,
      ),
    ),

  /** An event: `logEvent("pay_tapped", { amount: 499 })`. 25 parameters at most; only `items` can be a list. */
  logEvent,

  /**
   * A screen view of your own. The plugin already sends one per route: use this only for parts of a screen (tabs,
   * sheets) or with `AnalyticsPlugin(screenViews = false)`.
   */
  logScreenView: (p: { screen_name: string; screen_class?: string }): Promise<boolean> =>
    logEvent("screen_view", { screen_name: p.screen_name, screen_class: p.screen_class ?? p.screen_name }),

  /** Your own user id (a customer code); null or "" clears it on logout. Never a phone number, an email or a VPA. */
  setUserId: (id: string | null): Promise<boolean> => sent(Native.setUserId({ id }, unowned)),

  /** A user property (24-character name, 36-character value); null clears it. */
  setUserProperty: (name: string, value: string | null): Promise<boolean> =>
    sent(Native.setUserProperty({ name, value }, unowned)),

  setUserProperties: (values: Record<string, string | null>): Promise<boolean> =>
    sent(Native.setUserProperties({ values }, unowned)),

  /** Parameters on every later event of this launch; null clears them (the plugin's `zn_bundle` stays). */
  setDefaultEventParameters: (params: Record<string, ParamValue> | null): Promise<boolean> =>
    sent(Native.setDefaultEventParameters({ params: params ? clean(params)! : null }, unowned)),

  /** Analytics' id for this install, or null (off, no Firebase). */
  getAppInstanceId: (): Promise<string | null> => Native.getAppInstanceId({}, unowned).catch(() => null),

  /** Clears this install's Analytics data on the phone and starts a new app instance id (a user's "delete my data"). */
  resetAnalyticsData: (): Promise<boolean> => quietly(Native.resetAnalyticsData({}, unowned)),

  /** How long the app may be away before a new session starts. Analytics' default is 30 minutes. */
  setSessionTimeoutDuration: (ms: number): Promise<boolean> => quietly(Native.setSessionTimeoutDuration({ ms }, unowned)),

  logLogin: recommended<{ method: string }>("login"),
  logSignUp: recommended<{ method: string }>("sign_up"),
  logAppOpen: recommended<Params>("app_open"),
  logSearch: recommended<{ search_term: string }>("search"),
  logSelectContent: recommended<{ content_type: string; item_id: string }>("select_content"),
  logShare: recommended<{ content_type: string; item_id: string; method: string }>("share"),
  logViewItem: recommended<PurchaseParams>("view_item"),
  logViewItemList: recommended<{ item_list_id?: string; item_list_name?: string; items?: Item[] }>("view_item_list"),
  logSelectItem: recommended<{ item_list_id?: string; item_list_name?: string; items?: Item[] }>("select_item"),
  logAddToCart: recommended<PurchaseParams>("add_to_cart"),
  logRemoveFromCart: recommended<PurchaseParams>("remove_from_cart"),
  logViewCart: recommended<PurchaseParams>("view_cart"),
  logBeginCheckout: recommended<PurchaseParams>("begin_checkout"),
  logAddPaymentInfo: recommended<PurchaseParams & { payment_type?: string }>("add_payment_info"),
  logPurchase: recommended<PurchaseParams>("purchase"),
  logRefund: recommended<PurchaseParams>("refund"),
  logViewPromotion: recommended<Params>("view_promotion"),
  logSelectPromotion: recommended<Params>("select_promotion"),
  logEarnVirtualCurrency: recommended<{ virtual_currency_name: string; value: number }>("earn_virtual_currency"),
  logSpendVirtualCurrency: recommended<{ virtual_currency_name: string; value: number; item_name: string }>("spend_virtual_currency"),
  logTutorialBegin: recommended<Params>("tutorial_begin"),
  logTutorialComplete: recommended<Params>("tutorial_complete"),
}

/** RN Firebase's names, for code that ports over: `analytics().logEvent(...)`, `getAnalytics()`. */
export const analytics = () => Analytics
export const getAnalytics = () => Analytics
