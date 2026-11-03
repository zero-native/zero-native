// Permissions: ask once, in one place. Native side: android/runtime/.../ZnPermissions.kt. Guide: docs/guide-notes.md §32.
//
//   const { camera } = await Permissions.request(["camera"])
//   if (camera === "blocked") Os.openSettings() // Android won't show the dialog again
//
// Each permission must be in the manifest (a plugin's own manifest counts).
import { callNative } from "./calls"

/** "blocked": refused, and Android won't ask again: only the app's settings page can change it. */
export type PermissionState = "granted" | "denied" | "blocked"

/** A short name, or a full `android.permission.X`. */
export type PermissionName = "camera" | "contacts" | "location" | "microphone" | "notifications" | (string & {})

/**
 * Each name's state. "location" asks for precise and approximate together (Android 12+ ignores precise alone), and is
 * "granted" if the user gave either. `"location.precise"` says if precise was given too.
 */
export type PermissionAnswer<N extends PermissionName> = Record<N, PermissionState> &
  ("location" extends N ? { "location.precise": PermissionState } : unknown)

const call = (method: string, names: readonly PermissionName[]) =>
  callNative<Record<string, PermissionState>>("Permissions", method, { names, __v: 1 }, { owned: false })

export const Permissions = {
  /** Shows Android's dialog for what isn't granted. Errors: `busy`, `no_activity`, `not_declared`. */
  request: <N extends PermissionName>(names: readonly N[]) => call("request", names) as Promise<PermissionAnswer<N>>,

  /** The state now, with no dialog. A permission never asked for is "denied". */
  status: <N extends PermissionName>(names: readonly N[]) => call("status", names) as Promise<PermissionAnswer<N>>,
}
