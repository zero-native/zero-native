import { describe, expect, test } from "bun:test"
import { readRoutes } from "../src/routes"

const read = (body: string) =>
  readRoutes(
    `import { defineRoutes } from "@zero-native/core"
import { HomeScreen } from "./HomeScreen"
import { AmountScreen as Amount } from "./AmountScreen"
import { ReceiptScreen } from "./ReceiptScreen"
${body}`,
    "routes.ts",
  )
const err = (body: string) => {
  try {
    read(body)
  } catch (e) {
    return (e as Error).message
  }
  return "no error"
}

describe("routes", () => {
  test("reads the table in source order with defaults", () => {
    const routes = read(`export const routes = defineRoutes({
      home: { path: "/", screen: HomeScreen },
      amount: { path: "/pay/:merchantId", screen: Amount, deepLink: true },
      receipt: { path: "/receipt/:ztc", screen: ReceiptScreen, transition: "modal", safeArea: { top: false }, statusBar: "light", restore: false },
    })`)
    expect(routes!.map((r) => r.name)).toEqual(["home", "amount", "receipt"])
    expect(routes![0]).toEqual({
      name: "home", path: "/", component: "HomeScreen", transition: "push", safeArea: "all", statusBar: "dark", deepLink: false,
      keyboard: "resize", restore: true,
    })
    expect(routes![1].component).toBe("AmountScreen") // the exported name, not the local alias
    expect(routes![1].deepLink).toBe(true)
    expect(routes![2]).toMatchObject({ transition: "modal", safeArea: { top: false, bottom: true }, statusBar: "light", restore: false })
  })

  test("a native screen has no component, and options as usual", () => {
    const routes = read(`export const routes = defineRoutes({
      home: { path: "/", screen: HomeScreen },
      scan: { path: "/scan", native: "scanner.full", safeArea: "none", secure: true },
    })`)
    expect(routes![1]).toMatchObject({ name: "scan", component: null, native: "scanner.full", safeArea: "none", secure: true })
    expect("native" in routes![0]).toBe(false)
    expect("secure" in routes![0]).toBe(false)
  })

  test("native screen errors", () => {
    const home = `home: { path: "/", screen: HomeScreen }`
    expect(err(`defineRoutes({ ${home}, a: { path: "/a", screen: HomeScreen, native: "x.y" } })`)).toContain("both screen and native")
    expect(err(`defineRoutes({ a: { path: "/", native: "x.y" } })`)).toContain("start route can't be a native screen")
    expect(err(`defineRoutes({ ${home}, a: { path: "/a", native: "full" } })`)).toContain('must be "<plugin>.<name>"')
    expect(err(`const n = "x.y"; defineRoutes({ ${home}, a: { path: "/a", native: n } })`)).toContain("string literal")
    expect(err(`defineRoutes({ ${home}, a: { path: "/a", secure: 1, screen: HomeScreen } })`)).toContain("unsupported secure")
  })

  test("tabs: names in order, only on routes that have them", () => {
    const routes = read(`export const routes = defineRoutes({
      home: { path: "/", screen: HomeScreen, tabs: ["pay", "stores", "offers"], deepLink: true },
      amount: { path: "/pay/:merchantId", screen: Amount, tabs: ["pay", "stores"] },
    })`)
    expect(routes![0].tabs).toEqual(["pay", "stores", "offers"])
    expect(routes![1].tabs).toEqual(["pay", "stores"])
    expect(read(`defineRoutes({ home: { path: "/", screen: HomeScreen } })`)![0]).not.toHaveProperty("tabs")
  })

  test("tabs errors", () => {
    const home = `home: { path: "/", screen: HomeScreen }`
    expect(err(`defineRoutes({ ${home}, a: { path: "/a", screen: Amount, tabs: ["one"] } })`)).toContain("at least two names")
    expect(err(`defineRoutes({ ${home}, a: { path: "/a", screen: Amount, tabs: "one" } })`)).toContain("at least two names")
    expect(err(`defineRoutes({ ${home}, a: { path: "/a", screen: Amount, tabs: ["x", "x"] } })`)).toContain('"x" is used twice')
    expect(err(`defineRoutes({ ${home}, a: { path: "/a", screen: Amount, tabs: ["x", "2y"] } })`)).toContain("must start with a letter")
    expect(err(`defineRoutes({ ${home}, a: { path: "/a", native: "x.y", tabs: ["p", "q"] } })`)).toContain("native screen can't have tabs")
    expect(err(`defineRoutes({ ${home}, a: { path: "/a/:tab", screen: Amount, tabs: ["p", "q"] } })`)).toContain("can't have a :tab param")
    // "/" with tab "offers" links to "/offers", which another route already uses
    expect(err(`defineRoutes({ home: { path: "/", screen: HomeScreen, tabs: ["pay", "offers"] }, o: { path: "/offers", screen: Amount } })`))
      .toContain('the link to its tab "/offers" is also the path of route "o"')
    expect(err(`defineRoutes({ ${home}, h: { path: "/h/:id", screen: Amount, tabs: ["a", "b"] }, o: { path: "/h/:x/b", screen: Amount } })`))
      .toContain('"/h/:/b" is also the path of route "o"')
  })

  test("a file without defineRoutes", () => {
    expect(readRoutes(`export const x = 1`, "a.ts")).toBeNull()
  })

  test("errors point at the source", () => {
    expect(err(`defineRoutes({ amount: { path: "/pay", screen: Amount } })`)).toMatch(/routes\.ts:\d+:\d+: one route needs path "\/"/)
    expect(err(`defineRoutes({ home: { path: "pay", screen: HomeScreen } })`)).toMatch(/must start with "\/"/)
    expect(err(`defineRoutes({ home: { path: "/", screen: HomeScreen }, a: { path: "/p/:x/:x", screen: Amount } })`)).toMatch(/":x" is used twice/)
    expect(err(`defineRoutes({ home: { path: "/", screen: HomeScreen }, a: { path: "/p/:x", screen: Amount }, b: { path: "/p/:y", screen: ReceiptScreen } })`))
      .toMatch(/same path pattern as "a"/)
    expect(err(`defineRoutes({ home: { path: "/", screen: Missing } })`)).toMatch(/"Missing" is not imported or declared/)
    expect(err(`defineRoutes({ home: { path: "/", screen: HomeScreen, transition: "slide" } })`)).toMatch(/unsupported transition "slide"/)
    expect(err(`defineRoutes({ home: { path: "/", screen: HomeScreen, color: 1 } })`)).toMatch(/unknown route option "color"/)
    expect(err(`defineRoutes({ home: { path: "/", screen: HomeScreen, keyboard: "pan" } })`)).toMatch(/unsupported keyboard "pan"/)
    expect(err(`defineRoutes({ "1": { path: "/", screen: HomeScreen } })`)).toMatch(/must start with a letter/)
    expect(err(`defineRoutes({ home: { path: "/", screen: HomeScreen } }); defineRoutes({})`)).toMatch(/only one defineRoutes/)
  })
})
