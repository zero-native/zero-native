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
}

export interface RouteDef<Path extends string = string, Props = any> extends RouteOptions {
  path: Path
  /** The screen component (it returns JSX). */
  screen: (props: Props) => unknown
}

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
  [K in keyof R]: R[K] extends RouteDef<infer Path, infer Props>
    ? keyof PathParams<Path> extends keyof Props
      ? PathParams<Path> extends Pick<Props, keyof PathParams<Path> & keyof Props>
        ? R[K]
        : RouteError<"every :param in the path must be a string prop of the screen">
      : RouteError<"the screen doesn't take every :param in the path as a prop">
    : never
}

export function defineRoutes<const R extends Record<string, RouteDef>>(routes: R & Checked<R>): R {
  return routes
}

export type RouteName<R> = keyof R & string
/** The params `nav.push(name, params)` needs: the screen's props. */
export type RouteParams<R, K extends keyof R> = R[K] extends RouteDef<string, infer Props> ? Props : never
