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
      receipt: { path: "/receipt/:ztc", screen: ReceiptScreen, transition: "modal", safeArea: { top: false }, statusBar: "light" },
    })`)
    expect(routes!.map((r) => r.name)).toEqual(["home", "amount", "receipt"])
    expect(routes![0]).toEqual({
      name: "home", path: "/", component: "HomeScreen", transition: "push", safeArea: "all", statusBar: "dark", deepLink: false,
      keyboard: "resize",
    })
    expect(routes![1].component).toBe("AmountScreen") // the exported name, not the local alias
    expect(routes![1].deepLink).toBe(true)
    expect(routes![2]).toMatchObject({ transition: "modal", safeArea: { top: false, bottom: true }, statusBar: "light" })
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
