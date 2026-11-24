// Routes (ARCHITECTURE.md §11): one typed `routes.ts` per app.
//
//   export const routes = defineRoutes({
//     home:   { path: "/", screen: HomeScreen },
//     amount: { path: "/pay/:merchantId", screen: AmountScreen, deepLink: true },
//   })
//
// The compiler reads this call at build time (it never runs it) and writes the route table into the bundle
// manifest, in the order the routes are written. At runtime `defineRoutes` only returns the table, so navigation
// (step 2.2) can look routes up by name with typed params.
import type { View } from "./view"

export type Transition = "push" | "modal" | "fade" | "none"
export type SafeArea = "all" | "none" | { top?: boolean; bottom?: boolean }

export interface RouteOptions {
  /** How the screen comes in. Default "push". */
  transition?: Transition
  /** Which edges native keeps clear of system bars. Default "all" (step 2.3). */
  safeArea?: SafeArea
  /** Status and navigation bar icon colour: "dark" icons for light screens (default) or "light". */
  statusBar?: "dark" | "light"
  /** Allow opening this route from a link (zn://<app>/<path>). Off by default: a link is an outside entry point. */
  deepLink?: boolean
  /**
   * When the keyboard opens: "resize" (default) shrinks the screen to the space above it, so a focused field and a
   * bottom button stay visible; "none" lets the keyboard cover the screen.
   */
  keyboard?: "resize" | "none"
  /**
   * Reopen this screen when Android brings the app back after killing it in the background (default true; step
   * 3.9). false for screens that must never come back on their own, such as a "payment done" screen: it and the
   * screens above it are left out, and the user lands on the screen below it.
   */
  restore?: boolean
  /** No screenshots or screen recordings while this route is on top (Android's FLAG_SECURE). */
  secure?: boolean
  /**
   * The screen below stays drawn under this one (registry 24; RN's `presentation: "transparentModal"`): a photo
   * viewer whose backdrop fades as you drag it down, a dialog drawn in JS. The screen comes in and goes with no
   * transition: animate its content yourself (fade a backdrop, fly a photo in), and play it backwards in useBack
   * before nav.back(). Give its root no background (or a see-through one). An older app draws it as a normal screen.
   */
  transparent?: boolean
  /**
   * With `transparent: true`: VoiceOver / TalkBack skip the screens drawn under this one while it shows (as RN's
   * accessibilityViewIsModal), so a screen-reader user can't wander onto the buttons behind a photo viewer. Off by
   * default: a see-through screen that only covers part of the screen below (a tooltip, a toast drawn in JS) leaves
   * it readable. Android ignores it for now (the screens below stay in TalkBack's tree there).
   */
  accessibilityHidesBelow?: boolean
}

export interface RouteDef<Path extends string = string, Props = any> extends RouteOptions {
  path: Path
  /** The screen component (it returns JSX). */
  screen: (props: Props) => unknown
  /**
   * The screen's tabs, first = the default one: `tabs: ["pay", "stores", "offers"]`. The screen shows them with
   * `useTabs(route)` and `<Tabs>`. With `deepLink`, a link to "<path>/<tab>" opens that tab (guide notes §40).
   */
  tabs?: readonly string[]
}

/** A plugin's native screen as a route: `scan: { path: "/scan", native: "scanner.full" }` (docs/plugins.md §5). */
export interface NativeRouteDef<Path extends string = string> extends RouteOptions {
  path: Path
  native: string
}

export type AnyRouteDef = RouteDef | NativeRouteDef

/** `"/pay/:merchantId/:tab"` → `{ merchantId: string; tab: string }`. */
export type PathParams<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? { [K in Name]: string } & PathParams<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? { [K in Name]: string }
    : {}

/** Shown by the editor on `screen` when a route is wrong (nothing can be assigned to it). */
type RouteError<Message extends string> = { screen: never; error: Message }

/** Every `:name` in the path must be a string prop of the screen. */
type Checked<R> = {
  [K in keyof R]: R[K] extends NativeRouteDef ? R[K] : R[K] extends RouteDef<infer Path, infer Props>
    ? keyof PathParams<Path> extends keyof Props
      ? PathParams<Path> extends Pick<Props, keyof PathParams<Path> & keyof Props>
        ? R[K]
        : RouteError<"every :param in the path must be a string prop of the screen">
      : RouteError<"the screen doesn't take every :param in the path as a prop">
    : never
}

export function defineRoutes<const R extends Record<string, AnyRouteDef>>(routes: R & Checked<R>): R {
  return routes
}

export type RouteName<R> = keyof R & string
/** The routes that have `tabs`. */
export type TabRouteName<R> = { [K in RouteName<R>]: R[K] extends { tabs: readonly string[] } ? K : never }[RouteName<R>]
/** A route's tab names: `"pay" | "stores" | "offers"`. */
export type TabName<R, K extends keyof R> = R[K] extends { tabs: readonly (infer T)[] } ? T & string : string
/** The params `nav.push(name, params)` needs: the screen's props. */
export type RouteParams<R, K extends keyof R> = R[K] extends RouteDef<string, infer Props>
  ? Props
  : R[K] extends NativeRouteDef
    ? Record<string, unknown>
    : never
