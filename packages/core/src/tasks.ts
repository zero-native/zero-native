// Background tasks: JS that runs with no screen. Native side: android/runtime/.../ZnBackground.kt. Guide: docs/guide-notes.md §36
//
//   defineTask("sync", async (data, signal) => {     // at the top of main.ts, so it is there on a start with no screens
//     await fetch(url, { signal })                   // signal: aborted at the time limit (30 s by default)
//   })
//
// A plugin runs it from Kotlin: ZnBackground.run("sync", json) { outcome -> ... }. The app may have no Activity: a task uses no nav.
import { APP, AppEvent } from "./app-events"
import { nativeModule } from "./calls"
import { reportError } from "./errors"
import { onEvent } from "./events"

export type TaskFunction<T = any> = (data: T, signal: AbortSignal) => unknown

interface TasksModule {
  done(args: { id: string; outcome: "done" | "failed" | "no_task" }): Promise<boolean>
}

const Native = nativeModule<TasksModule>("Tasks", { version: 1 })
const tasks = new Map<string, TaskFunction>()
const running = new Map<string, AbortController>()

/** Names a task. Call it at the top of main.ts: native may ask for it as soon as JS has loaded. */
export function defineTask<T = any>(name: string, task: TaskFunction<T>): void {
  if (tasks.has(name)) throw new Error(`zero-native: task "${name}" is defined twice`)
  tasks.set(name, task)
}

function answer(id: string, outcome: "done" | "failed" | "no_task"): void {
  running.delete(id)
  Native.done({ id, outcome }).catch((err) => reportError("task answer", err))
}

async function run(id: string, name: string, data: unknown, task: TaskFunction): Promise<void> {
  const controller = new AbortController()
  running.set(id, controller)
  try {
    await task(data, controller.signal)
    answer(id, "done")
  } catch (err) {
    reportError(`task "${name}"`, err)
    answer(id, "failed")
  }
}

/** Called by startApp. */
export function installTasks(): void {
  onEvent(APP, AppEvent.Task, (payload) => {
    const message = JSON.parse(String(payload)) as { id: string; name?: string; data?: unknown; abort?: boolean }
    if (message.abort) {
      running.get(message.id)?.abort()
      running.delete(message.id)
      return
    }
    const task = tasks.get(message.name!)
    if (task) void run(message.id, message.name!, message.data, task)
    else answer(message.id, "no_task")
  })
}

export function resetTasksForTests(): void {
  tasks.clear()
  running.clear()
}
