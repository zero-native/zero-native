package dev.zeronative.runtime

import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject

/**
 * Runs a JS task with no screen (docs/plugins.md §6): `defineTask("sync", async (data, signal) => { ... })` in JS, and
 * `ZnBackground.run("sync", json) { outcome -> ... }` from a plugin. JS already runs with no Activity, so this adds only a
 * queue until JS has loaded, a time limit and one answer per task. It doesn't keep the process alive: the plugin's own
 * Android job does (a service, `goAsync`).
 */
object ZnBackground : ZnModuleBase("Tasks", version = 1) {
    enum class Outcome { DONE, FAILED, NO_TASK, TIMED_OUT }

    private class Task(val name: String, val data: JSONObject?, val onDone: (Outcome) -> Unit, val timeout: Runnable)

    private const val TAG = "zn"
    private val main = Handler(Looper.getMainLooper())
    // All main thread.
    private val tasks = HashMap<String, Task>()
    private val queued = ArrayList<String>()
    private var loaded = false
    private var nextId = 0

    /** Main thread: a task is queued or running (ZnRuntime.jsError tells a task's hang from a screen's). */
    internal val running: Boolean get() = tasks.isNotEmpty()

    init {
        function("done", onMain = true) { call ->
            val outcome = when (call.string("outcome")) {
                "done" -> Outcome.DONE
                "no_task" -> Outcome.NO_TASK
                else -> Outcome.FAILED
            }
            finish(call.string("id"), outcome)
            call.resolve(true)
        }
    }

    /**
     * Runs task [name] with [data]. [onDone] is called once, on the main thread. At [timeoutMs] JS's `signal` is aborted and
     * the outcome is TIMED_OUT; a late answer is dropped. Any thread.
     */
    fun run(name: String, data: JSONObject? = null, timeoutMs: Long = 30_000, onDone: (Outcome) -> Unit) {
        main.post {
            if (!ZnRuntime.isStarted) { // another process of the app: JS runs only in the main one
                onDone(Outcome.FAILED)
                return@post
            }
            val id = "${++nextId}"
            val timeout = Runnable {
                val queuedOnly = queued.remove(id)
                if (!queuedOnly) ZnRuntime.dispatchEvent(ZnAppEvent.APP, ZnAppEvent.TASK, JSONObject().put("id", id).put("abort", true).toString())
                finish(id, Outcome.TIMED_OUT)
            }
            tasks[id] = Task(name, data, onDone, timeout)
            main.postDelayed(timeout, timeoutMs)
            if (loaded) send(id) else queued += id
        }
    }

    private fun send(id: String) {
        val task = tasks[id] ?: return
        val message = JSONObject().put("id", id).put("name", task.name).put("data", task.data ?: JSONObject.NULL)
        ZnRuntime.dispatchEvent(ZnAppEvent.APP, ZnAppEvent.TASK, message.toString())
    }

    private fun finish(id: String, outcome: Outcome) {
        val task = tasks.remove(id) ?: return // timed out already, or an answer from JS that was replaced
        main.removeCallbacks(task.timeout)
        Log.i(TAG, "task ${task.name}: $outcome")
        try {
            task.onDone(outcome)
        } catch (e: Exception) {
            Log.e(TAG, "task ${task.name}: onDone threw", e)
        }
    }

    /** Main thread: the main script ran, or failed. */
    internal fun jsLoaded(ok: Boolean) {
        loaded = ok
        val waiting = queued.toList()
        queued.clear()
        for (id in waiting) if (ok) send(id) else finish(id, Outcome.FAILED)
    }

    /** Main thread: JS is being replaced. What it was running can't answer now; what is queued waits for the new JS. */
    internal fun jsGone() {
        loaded = false
        for (id in tasks.keys.filter { it !in queued }) finish(id, Outcome.FAILED)
    }
}
