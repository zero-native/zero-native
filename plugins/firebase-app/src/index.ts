// The Firebase base plugin's JS side (RN Firebase's `app` and `installations` modules). Native side:
// android/.../FirebaseAppPlugin.kt.
//
//   const app = await Firebase.app()                  // { available, name, projectId, appId, ... }
//   await Firebase.setDataCollectionDefault(false)    // every Firebase library off until the user agrees
//   const id = await installations().getId()          // the id Firebase knows this install by (A/B tests, FCM, ...)
//
// Each call answers with a value and never rejects. With no Firebase in the app (no google-services.json) `app()` says
// `available: false` and Installations answers null.
import { nativeModule, type CallOptions } from "@zero-native/core"

export interface FirebaseAppInfo {
  /** False: Firebase isn't set up in this app (no google-services.json), or this plugin is missing. */
  available: boolean
  /** "[DEFAULT]", like RN Firebase's `app().name`. */
  name?: string
  projectId?: string | null
  appId?: string
  senderId?: string | null
  storageBucket?: string | null
  /**
   * Firebase's own switch for every library that collects by itself (Analytics, Crashlytics, Performance, FCM's
   * auto-init). Kept across starts. A library's own switch (like Crashlytics' collection setting) wins over it.
   */
  dataCollectionDefault?: boolean
}

export interface InstallationToken {
  token: string
  /** ms since 1970. */
  expiresAt: number
}

export interface FirebaseModule {
  app(args?: Record<string, never>, options?: CallOptions): Promise<FirebaseAppInfo>
  setDataCollectionDefault(args: { on: boolean }, options?: CallOptions): Promise<FirebaseAppInfo>
}

export interface InstallationsModule {
  getId(args?: Record<string, never>, options?: CallOptions): Promise<string | null>
  getToken(args: { forceRefresh?: boolean }, options?: CallOptions): Promise<InstallationToken | null>
  delete(args?: Record<string, never>, options?: CallOptions): Promise<boolean>
}

const NativeApp = nativeModule<FirebaseModule>("Firebase", { version: 1 })
const NativeInstallations = nativeModule<InstallationsModule>("Installations", { version: 1 })
// Not tied to a screen: a setting must not be cancelled because the screen that set it closed.
const unowned = { owned: false }
const off: FirebaseAppInfo = { available: false }

export const Firebase = {
  /** This app's Firebase setup. No network. */
  app: (): Promise<FirebaseAppInfo> => NativeApp.app({}, unowned).catch(() => off),

  /**
   * RN Firebase's `setAutomaticDataCollectionEnabled`: turns Firebase's default collection on or off, kept across
   * starts. Answers the new info. To start with it off, also set `firebase_data_collection_default_enabled` to false in
   * the app's manifest (README).
   */
  setDataCollectionDefault: (on: boolean): Promise<FirebaseAppInfo> =>
    NativeApp.setDataCollectionDefault({ on }, unowned).catch(() => off),
}

export const Installations = {
  /** The install id, or null (no Firebase, or no network on the very first call). */
  getId: (): Promise<string | null> => NativeInstallations.getId({}, unowned).catch(() => null),

  /** A short-lived token for your own server to check the install with Firebase. Null when it can't be had. */
  getToken: (forceRefresh = false): Promise<InstallationToken | null> =>
    NativeInstallations.getToken({ forceRefresh }, unowned).catch(() => null),

  /** Deletes the install id and its data at Firebase (a user's "delete my data"). A new id comes on next use. */
  delete: (): Promise<boolean> => NativeInstallations.delete({}, unowned).catch(() => false),
}

/** RN Firebase's names, for code that ports over: `firebase.app()`, `installations().getId()`. */
export const firebase = { app: Firebase.app }
export const installations = () => Installations
export const getInstallations = () => Installations
