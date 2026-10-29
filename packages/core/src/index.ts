// @zero-native/core: the JS side of the runtime.
import { installConsole } from "./log"
import { installEvents } from "./events"
import { installTimers } from "./timers"
import { installCalls } from "./calls"
import { installAbort } from "./abort"

export * from "./native"
export { parseColor } from "./color"
export { batch, computed, createRoot, effect, onCleanup, signal, untrack, type Signal } from "./signals"
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
export { nav, startApp, useBack, useImpressions, type ImpressionOptions, type Register } from "./nav"
export { insets, type Insets } from "./insets"
export { flowStore, type StoreRead } from "./flowstore"
export { Keyboard, type KeyboardModule } from "./keyboard"
export {
  callNative,
  nativeModule,
  NativeError,
  onNativeEvent,
  pendingCallCount,
  type CallOptions,
  type ModuleHandle,
} from "./calls"
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

/** Installs console, timers and event dispatch on the global object. Call once, first thing in the bundle. */
export function installRuntime(): void {
  installConsole()
  installTimers()
  installEvents()
  installAbort()
  installCalls()
}
