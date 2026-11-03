// NetInfo: the state part of @react-native-community/netinfo, same names and meaning. Native side:
// android/runtime/.../ZnNetInfo.kt.
//
//   const state = await NetInfo.fetch()
//   const stop = NetInfo.addEventListener((state) => { if (state.isConnected === false) showOfflineBar() })
//
//   function PayScreen() {
//     const net = useNetInfo()
//     return <Text>{net.isInternetReachable === false ? "No internet" : ""}</Text>
//   }
//
// `isInternetReachable` is Android's own check (the network is "validated"); there is no extra request.
import { callNative, onNativeEvent } from "./calls"
import { reportError } from "./errors"
import { getOwner, onCleanup, signal } from "./signals"

export type NetInfoStateType = "unknown" | "none" | "cellular" | "wifi" | "bluetooth" | "ethernet" | "vpn" | "other"

export interface NetInfoState {
  type: NetInfoStateType
  /** null: not known yet. */
  isConnected: boolean | null
  /** null: not known yet. */
  isInternetReachable: boolean | null
  /** null when there is no network (or it is not known). */
  details: { isConnectionExpensive: boolean } | null
}

const UNKNOWN: NetInfoState = { type: "unknown", isConnected: null, isInternetReachable: null, details: null }

/** A copy with the keys in one order, so two equal states give the same JSON. */
function read(raw: unknown): NetInfoState {
  const s = (raw ?? {}) as Partial<NetInfoState>
  const details = s.details ? { isConnectionExpensive: s.details.isConnectionExpensive === true } : null
  return {
    type: s.type ?? "unknown",
    isConnected: s.isConnected ?? null,
    isInternetReachable: s.isInternetReachable ?? null,
    details,
  }
}

const fetchState = () => callNative<unknown>("NetInfo", "fetch", { __v: 1 }, { owned: false }).then(read)

export const NetInfo = {
  /** The state now. */
  fetch: (): Promise<NetInfoState> => fetchState(),

  /** Reads the state again now (on Android the same as `fetch`). */
  refresh: (): Promise<NetInfoState> => fetchState(),

  /**
   * Calls [listener] soon with the state now, then each time it changes. Returns a function that stops it. Called while
   * a screen is being built, it stops by itself when the screen closes.
   */
  addEventListener(listener: (state: NetInfoState) => void): () => void {
    let active = true
    let last: string | null = null
    let heardChange = false
    const deliver = (state: NetInfoState) => {
      const json = JSON.stringify(state)
      if (!active || json === last) return
      last = json
      try {
        listener(state)
      } catch (err) {
        reportError("NetInfo listener", err)
      }
    }
    const off = onNativeEvent("NetInfo", "change", (payload) => {
      heardChange = true
      deliver(read(payload))
    })
    fetchState().then(
      // A change that came first is newer than this answer.
      (state) => {
        if (!heardChange) deliver(state)
      },
      (err) => {
        if (active) globalThis.__zn_log(2, `NetInfo: can't read the network: ${err instanceof Error ? err.message : String(err)}`)
      },
    )
    const stop = () => {
      active = false
      off()
    }
    if (getOwner()) onCleanup(stop)
    return stop
  },
}

/**
 * The network state for a screen: call it in the screen body. Reading a field (`net.isConnected`) inside JSX or an
 * effect follows changes. Starts as "unknown" (all null), as in the library, until native answers.
 */
export function useNetInfo(): NetInfoState {
  if (!getOwner()) globalThis.__zn_log(2, "useNetInfo() outside a screen: it never stops listening; call it in a screen body")
  const state = signal<NetInfoState>(UNKNOWN)
  NetInfo.addEventListener((s) => state.set(s))
  return {
    get type() {
      return state().type
    },
    get isConnected() {
      return state().isConnected
    },
    get isInternetReachable() {
      return state().isInternetReachable
    },
    get details() {
      return state().details
    },
  }
}
