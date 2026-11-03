// @zero-native/core: the JS side of the runtime.
import { installConsole } from "./log"
import { installEvents } from "./events"
import { installTimers } from "./timers"
import { installCalls } from "./calls"
import { installAbort } from "./abort"
import { installText } from "./text"
import { installFetch } from "./fetch"
import { installRejectionTracking } from "./errors"
import { installIntlCache } from "./intl"

export * from "./native"
export { parseColor } from "./color"
export { batch, computed, createRoot, detached, effect, onCleanup, signal, untrack, type Signal } from "./signals"
export {
  allocInstanceId,
  component,
  each,
  insert,
  textInput,
  list,
  on,
  ready,
  renderRoot,
  slot,
  SlotKind,
  str,
  view,
  when,
  type Instance,
  type ListOptions,
  type View,
} from "./view"
export { onEvent } from "./events"
export { nav, onNavResult, restorableSignal, startApp, useBack, useImpressions, type AppOptions, type ImpressionOptions, type OpenedLink, type Register } from "./nav"
export { insets, type Insets } from "./insets"
export { appState, onAppState, type AppState } from "./app-state"
export { Permissions, type PermissionName, type PermissionState } from "./permissions"
export { launches, type LaunchRecord } from "./launches"
export { Os, type Haptic, type OsInfo } from "./os"
export { flowStore, type StoreRead } from "./flowstore"
export {
  createStorage,
  persistedSignal,
  storage,
  type Storage,
  type StorageListener,
  type StoredValue,
} from "./storage"
export { SecureStore } from "./secure-store"
export { Keyboard, type KeyboardModule } from "./keyboard"
export { toast, type ToastOptions } from "./toast"
export {
  callNative,
  nativeModule,
  NativeError,
  onNativeEvent,
  pendingCallCount,
  type BytesResult,
  type CallOptions,
  type ModuleHandle,
} from "./calls"
export {
  fetch,
  FetchError,
  Request,
  Response,
  setFetchDefaults,
  type BodyInit,
  type FetchDefaults,
  type FetchErrorCode,
  type FetchInit,
  type RedirectMode,
  type ResponseInit,
} from "./fetch"
export { Headers, type HeadersInit } from "./headers"
export { FormData, type FormFile, type FormValue } from "./formdata"
export { useAbortSignal } from "./abort"
export { colorScheme, onLowMemory, scheme, type ColorScheme } from "./appearance"
export { defineTask, type TaskFunction } from "./tasks"
export {
  defineRoutes,
  type PathParams,
  type RouteDef,
  type RouteName,
  type RouteOptions,
  type RouteParams,
  type SafeArea,
  type Transition,
} from "./routes"
export { setTimeout, setInterval, clearTimeout, clearInterval, activeTimerCount } from "./timers"
export { onError, type ErrorInfo, type ErrorKind } from "./errors"
export { Updates, type ApplyRefused, type UpdateCheckResult, type UpdateStatus } from "./updates"

/** Installs console, timers and event dispatch on the global object. Call once, first thing in the bundle. */
export function installRuntime(): void {
  installConsole()
  installTimers()
  installEvents()
  installAbort()
  installCalls()
  installText()
  installFetch()
  installRejectionTracking() // after timers: Hermes' tracker uses setTimeout
  installIntlCache()
}
