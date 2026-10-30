// The host functions native installs on the JS global (core/src/hermes_engine.cpp), with types.
// App code should not call these directly; the runtime and (later) the compiler's output do.

/** Values that can cross to native. Nothing else is allowed (ARCHITECTURE §7.2). */
export type NativeValue = null | boolean | number | string

declare global {
  // eslint-disable-next-line no-var
  var __zn_patch: (instance: number, slot: number, value: NativeValue) => void
  var __zn_mount: (
    templateId: number,
    parent: number,
    anchor: number,
    instance: number,
    index: number,
    values: NativeValue[],
  ) => void
  var __zn_remove: (instance: number) => void
  var __zn_move: (instance: number, toIndex: number) => void
  var __zn_nav: (kind: number, entry: number, route: number, params: string | null) => void
  var __zn_listSet: (instance: number, node: number, keys: string[], types: number[]) => void
  var __zn_listSplice: (
    instance: number,
    node: number,
    index: number,
    removeCount: number,
    keys: string[],
    types: number[],
  ) => void
  var __zn_listRow: (instance: number, node: number, key: string, row: number) => void
  /** The optional buffer range is raw binary input for native (copied during the call). */
  var __zn_call: (
    module: string,
    method: string,
    argsJson: string,
    callbackId: number,
    buffer?: ArrayBuffer,
    offset?: number,
    length?: number,
  ) => void
  var __zn_cancel: (callbackId: number) => void
  var __zn_setTimer: (delayMs: number, repeat: boolean) => number
  var __zn_clearTimer: (handle: number) => void
  var __zn_log: (level: number, message: string) => void
  /** A JS error that was caught (errors.ts): logged, and shown on the dev error screen in debug builds. */
  var __zn_error: (where: string, details: string) => void
  var __zn_now: () => number
  /** UTF-8 bytes → string. Bad bytes become U+FFFD; with `fatal`, bad bytes give undefined instead. */
  var __zn_utf8Decode: (buffer: ArrayBuffer, offset: number, length: number, fatal: boolean) => string | undefined
  /** String → UTF-8 bytes (a lone surrogate becomes U+FFFD). */
  var __zn_utf8Encode: (text: string) => ArrayBuffer
  // Defined by this package, called by native:
  var __zn_onTimer: (handle: number) => void
  /** `payload` is an ArrayBuffer for binary answers (app event 9, calls.ts). */
  var __zn_onEvent: (instance: number, eventId: number, payload: NativeValue) => void
}

/** Changes one slot value of an instance (batched; native applies it at the end of the tick). */
export function patch(instance: number, slot: number, value: NativeValue): void {
  globalThis.__zn_patch(instance, slot, value)
}

export function mount(
  templateId: number,
  parent: number,
  anchor: number,
  instance: number,
  index: number,
  values: NativeValue[],
): void {
  globalThis.__zn_mount(templateId, parent, anchor, instance, index, values)
}

export function remove(instance: number): void {
  globalThis.__zn_remove(instance)
}

export function move(instance: number, toIndex: number): void {
  globalThis.__zn_move(instance, toIndex)
}

/** Milliseconds from a monotonic clock (not wall time). */
export function now(): number {
  return globalThis.__zn_now()
}
