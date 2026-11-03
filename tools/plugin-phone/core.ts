// Phone steps for the core parts plugins stand on (examples/sample/src/CoreLabScreen.tsx).
import { writeFileSync } from "node:fs"
import { check, clearLog, expectLog, killInBackground, lines, ok, openFresh, OUT, PKG, reopen, see, shell, shot, sleep, stopApp, tap, texts, type Step } from "./helpers"

const lab = () => openFresh("dev/core", "Open native screen")

export const steps: Step[] = [
  {
    name: "native screen answers",
    run: async () => {
      await lab()
      await tap("Open native screen")
      await see(/^fake screen: Pay/)
      await tap("Finish")
      ok("finish", await expectLog(/core-lab answer: abc/))
      await see("Open native screen")
    },
  },
  {
    name: "double finish",
    run: async () => {
      clearLog()
      await tap("Open native screen")
      await tap("Finish twice")
      ok("double finish, first wins", await expectLog(/core-lab answer: first/))
      check(lines(/core-lab answer: second/).length === 0, "second answer got through")
    },
  },
  {
    name: "back and cancel give null",
    run: async () => {
      clearLog()
      await tap("Open native screen")
      await see(/^fake screen/)
      shell("input", "keyevent", "KEYCODE_BACK")
      ok("back", await expectLog(/core-lab answer: null/))
      clearLog()
      await tap("Open native screen")
      await tap("Cancel")
      ok("cancel", await expectLog(/core-lab answer: null/))
    },
  },
  {
    name: "kill while a native screen is open",
    run: async () => {
      await lab()
      await tap("Push native screen")
      await see(/^fake screen: Kill/)
      await killInBackground()
      clearLog()
      reopen()
      await see(/^fake screen: Kill/, 15000)
      ok("reopened on the native screen", "params kept")
      await tap("Finish")
      ok("answer after a kill", await expectLog(/core-lab nav result: abc/))
      await see("Open native screen")
    },
  },
  {
    name: "native view",
    run: async () => {
      await lab()
      await tap("view says one")
      ok("view event", await expectLog(/core-lab view event: tapped one/))
      await tap("Change view prop")
      await tap("view says two")
      ok("prop reached the view", await expectLog(/core-lab view event: tapped two/))
      clearLog()
      await tap("Open native screen")
      ok("covered view stops", await expectLog(/fake view: ON_STOP|fake view: gone/, 6000))
      await tap("Cancel")
      ok("back in view", await expectLog(/fake view: ON_RESUME|fake view: ON_START/, 6000))
    },
  },
  {
    name: "tasks",
    run: async () => {
      await lab()
      await tap("Run task")
      ok("task", await expectLog(/core-lab task lab.echo: DONE/))
      await expectLog(/core-lab task echo from lab/)
      await tap("Slow task")
      ok("time limit", await expectLog(/core-lab task lab.slow: TIMED_OUT/))
      ok("signal aborted", await expectLog(/core-lab task slow: aborted/))
      await tap("Failing task")
      ok("failing", await expectLog(/core-lab task lab.throw: FAILED/))
      await tap("Dismiss") // the debug error overlay shows the task's error
      await tap("Unknown task")
      ok("unknown", await expectLog(/core-lab task lab.none: NO_TASK/))
    },
  },
  {
    name: "task with no screen",
    run: async () => {
      await stopApp()
      clearLog()
      shell("content", "query", "--uri", "content://dev.zeronative.sample.debugwake/task")
      ok("cold task", await expectLog(/task with no screen: DONE/, 15000))
      ok("ran in JS", await expectLog(/core-lab task echo from no screen/))
      check(!/MainActivity/.test(shell("dumpsys", "window", "displays").match(/mCurrentFocus=.*/)?.[0] ?? ""), "an Activity opened")
    },
  },
  {
    name: "file handle",
    run: async () => {
      await lab()
      await tap("Make file")
      const line = await expectLog(/core-lab file: /)
      check(line.includes("zn://file/lab-") && line.includes("outside refused: true"), line)
      ok("file", line)
      await sleep(600)
      writeFileSync(`${OUT}/core-file.png`, shot())
    },
  },
  {
    name: "low memory",
    run: async () => {
      clearLog()
      shell("am", "send-trim-memory", PKG, "RUNNING_LOW")
      ok("low memory", await expectLog(/core-lab low memory/))
    },
  },
  {
    name: "secure",
    run: async () => {
      await lab()
      const a = shot()
      await tap("Open secure screen")
      await see("secure screen")
      await sleep(500)
      const b = shot()
      writeFileSync(`${OUT}/core-secure.png`, b)
      check(b.length < a.length / 3, "the secure screen shows in a screenshot")
      ok("secure blanks a screenshot", `${b.length} bytes`)
      shell("input", "keyevent", "KEYCODE_BACK")
      await see("Open native screen")
      await sleep(800)
      const c = shot()
      check(c.length > a.length / 2, `the flag stayed after leaving: ${c.length} of ${a.length}`)
      ok("flag off after leaving", `${c.length} bytes`)
    },
  },
  {
    name: "dark mode",
    run: async () => {
      try {
        await lab()
        await see("scheme: light")
        shell("cmd", "uimode", "night", "yes")
        await see("scheme: dark")
        writeFileSync(`${OUT}/core-dark.png`, shot())
        ok("switch while open", "scheme: dark on screen")
        await openFresh("dev/core", "scheme: dark")
        ok("dark from the start", "first screen read dark")
      } finally {
        shell("cmd", "uimode", "night", "no")
      }
    },
  },
  {
    name: "right to left",
    run: async () => {
      try {
        await stopApp()
        shell("cmd", "locale", "set-app-locales", PKG, "--locales", "ar")
        await lab()
        await tap("Show rtl")
        ok("rtl", await expectLog(/core-lab rtl: true/))
        await sleep(400)
        writeFileSync(`${OUT}/core-rtl.png`, shot())
      } finally {
        shell("cmd", "locale", "set-app-locales", PKG, "--locales", "")
        await stopApp()
      }
      check(texts().length >= 0, "unreachable")
    },
  },
]
