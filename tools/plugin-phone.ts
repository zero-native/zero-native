// The phone check for core and the official plugins, in one run: bun run tools/plugin-phone.ts [words in step names] [--no-hands | --hands]
// Install a debug sample first. Steps that need a person run last, and the script says what to do. Steps: tools/plugin-phone/.
import { lines, type Step } from "./plugin-phone/helpers"
import { steps as core } from "./plugin-phone/core"
import { steps as scanner } from "./plugin-phone/scanner"
import { steps as media } from "./plugin-phone/media"
import { steps as auth } from "./plugin-phone/auth"
import { steps as webview } from "./plugin-phone/webview"
import { steps as tabs } from "./plugin-phone/tabs"
import { steps as pdf } from "./plugin-phone/pdf"
import { steps as location } from "./plugin-phone/location"

const args = process.argv.slice(2)
const noHands = args.includes("--no-hands")
const handsOnly = args.includes("--hands")
const only = args.filter((a) => !a.startsWith("--")) // any of these words in a step's name
const all: Step[] = [...core, ...scanner, ...media, ...auth, ...webview, ...tabs, ...pdf, ...location].filter((s) => !only.length || only.some((w) => s.name.includes(w)))
const ordered = [...(handsOnly ? [] : all.filter((s) => !s.hands)), ...(noHands ? [] : all.filter((s) => s.hands))]
const failures: string[] = []
for (const step of ordered) {
  if (step.hands) console.log(`\n>>> YOUR TURN: ${step.hands}\n`)
  try {
    await step.run()
  } catch (e) {
    failures.push(step.name)
    console.log(`FAIL ${step.name}: ${(e as Error).message.slice(0, 400)}`)
  }
}
console.log(failures.length ? `\nFAILED (${failures.length} of ${ordered.length}): ${failures.join(", ")}` : `\nall ${ordered.length} steps passed`)
console.log(`crashes in the last log: ${lines(/FATAL EXCEPTION/).length}`)
process.exit(failures.length ? 1 : 0)
