package dev.zeronative.runtime

import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import android.net.ConnectivityManager
import android.os.SystemClock
import android.util.Log
import coil3.SingletonImageLoader
import coil3.network.NetworkHeaders
import coil3.network.httpHeaders
import coil3.request.CachePolicy
import coil3.request.Disposable
import coil3.request.ImageRequest

/**
 * Loads the pictures of <List> rows just past the screen, before they are drawn (image plan A, 2026-11-10; Pavan's go).
 *
 * Why: zn asked for a picture only when its <Image> was drawn, and a lazy list draws only the rows on screen. RN's
 * FlatList renders about 10 screens ahead, so its pictures were in memory before the user got there: zn's looked slower.
 *
 * How: the rows near the screen already have their instance (JS mounts a window of rows), so their `src` is known.
 * For the next [ROWS_AHEAD] rows in the scroll direction, Coil downloads each http(s) `src` into its **disk cache**.
 * When the row comes on screen, its <Image> reads the file from disk (a decode, no network) and fades in.
 * - Disk, not memory: Coil's memory cache key holds the drawn pixel size, which only layout knows (padding, flex,
 *   percent sizes). A preload at the wrong size would miss and hold memory for nothing. The download is the slow part.
 * - The preload is decoded at 1×1 px (Coil always decodes): cheap, and nothing big stays in memory.
 * - Its own queue, 3 at once in all ([ZnFetch.PRELOAD_MAX]): it never crowds an on-screen picture or an API call.
 * - Cancelled when its row's instance is gone (scrolled far away) or the list leaves the screen.
 * - Off with Android's Data Saver, for a minute after the system asks to free memory, and when the app set its own
 *   Coil loader (its requests can't use our queue).
 * - Known cost: Coil doesn't join two requests for one URL. A row that comes on screen while its preload still
 *   downloads may download the picture twice (counted in [doubles], logged).
 * Main thread only.
 */
internal object ZnImagePreload {
    private const val TAG = "zn"
    /** Rows loaded ahead of the screen, in the scroll direction. */
    const val ROWS_AHEAD = 8
    /** Pictures taken from one row (a row with a gallery doesn't fill the queue alone). */
    private const val MAX_PER_ROW = 4
    /** Instances looked at per row (a row is small; this only stops a strange tree). */
    private const val MAX_INSTANCES_PER_ROW = 64
    /** Preloads waiting or running at once, all lists together; more are skipped (the next scroll asks again). */
    private const val MAX_PENDING = 24
    /** URLs preloaded in this process, so a list scrolling back and forth doesn't ask again. */
    private const val DONE_KEEP = 512
    private const val LOW_MEMORY_PAUSE_MS = 60_000L
    private const val DATA_SAVER_CHECK_MS = 10_000L

    private class Job(val owner: String, val instance: Int, val disposable: Disposable)

    private val pending = HashMap<String, Job>()
    private val done = object : LinkedHashMap<String, Boolean>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Boolean>?) = size > DONE_KEEP
    }
    private var pausedUntil = 0L
    private var dataSaver = false
    private var dataSaverAt = Long.MIN_VALUE
    private var watching = false

    /** Times an on-screen picture was asked for while its preload still ran (the double download above). */
    var doubles = 0
        private set

    /**
     * The rows [instances] (the next rows past the screen, nearest first) of the list [owner]: preload their pictures.
     * Cancels this list's preloads whose row instance is gone.
     */
    fun want(context: Context, owner: String, instances: List<ZnInstance>, templates: List<ZnTemplate>) {
        val app = context.applicationContext
        watch(app)
        dropGone(owner)
        if (instances.isEmpty() || SystemClock.uptimeMillis() < pausedUntil || dataSaverOn(app)) return
        SingletonImageLoader.get(app) // makes our loader if no one did yet: then [ZnFetch.ownImageLoader] is known
        if (!ZnFetch.ownImageLoader) return
        val urls = ArrayList<String>(MAX_PER_ROW)
        var started = 0
        for (inst in instances) {
            if (pending.size >= MAX_PENDING) break
            urls.clear()
            collect(inst, templates, urls)
            for (url in urls) {
                if (url in done || url in pending || pending.size >= MAX_PENDING) continue
                start(app, owner, inst.id, url)
                started++
            }
        }
        if (started > 0) Log.d(TAG, "image preload: $started started for $owner (${pending.size} waiting or running)")
    }

    /** The list [owner] left the screen: its preloads stop. */
    fun cancelOwner(owner: String) {
        val it = pending.entries.iterator()
        while (it.hasNext()) {
            val e = it.next()
            if (e.value.owner == owner) {
                e.value.disposable.dispose()
                it.remove()
            }
        }
    }

    /**
     * An on-screen <Image> asks for [url]: no preload for it from now on (the on-screen load puts it in the disk cache;
     * one picture in many rows, a merchant's icon in a list of payments, was downloaded twice at start on the Lava).
     * Counts it when its preload is still running (see [doubles]).
     */
    fun onScreen(url: String) {
        if (url in pending) {
            doubles++
            Log.i(TAG, "image preload: on screen before its preload ended (${doubles} so far): $url")
        }
        if (isRemote(url)) done[url] = true
    }

    /** The http(s) `src` of the <Image> nodes in [root]'s tree, at most [MAX_PER_ROW]. Not inside a nested <List>. */
    internal fun collect(root: ZnInstance, templates: List<ZnTemplate>, out: MutableList<String>) {
        val queue = ArrayDeque<ZnInstance>()
        queue.add(root)
        var seen = 0
        while (queue.isNotEmpty() && out.size < MAX_PER_ROW && seen++ < MAX_INSTANCES_PER_ROW) {
            val inst = queue.removeFirst()
            val t = templates.getOrNull(inst.templateId) ?: continue
            for (n in t.nodes) {
                if (n.type != Registry.Component.IMAGE) continue
                val src = if (n.srcSlot >= 0) (if (inst.hasSlot(n.srcSlot)) inst.slot(n.srcSlot).value as? String else null) else n.src
                if (src != null && isRemote(src) && src !in out) {
                    out += src
                    if (out.size >= MAX_PER_ROW) return
                }
            }
            for (id in inst.allChildren()) ZnStore.find(id)?.let(queue::add)
        }
    }

    internal fun isRemote(src: String): Boolean =
        src.startsWith("https://", ignoreCase = true) || src.startsWith("http://", ignoreCase = true)

    private fun start(app: Context, owner: String, instance: Int, url: String) {
        val request = ImageRequest.Builder(app)
            .data(url)
            .size(1, 1) // decoded tiny: the file in the disk cache is what counts
            .memoryCachePolicy(CachePolicy.DISABLED)
            .diskCachePolicy(CachePolicy.ENABLED)
            .httpHeaders(NetworkHeaders.Builder().set(ZnFetch.PRELOAD_HEADER, "1").build())
            .listener(
                onSuccess = { _, _ -> finished(url, ok = true) },
                onError = { _, r -> finished(url, ok = false).also { Log.i(TAG, "image preload failed: $url (${r.throwable.message})") } },
                onCancel = { _ -> pending.remove(url) },
            )
            .build()
        val disposable = try {
            SingletonImageLoader.get(app).enqueue(request)
        } catch (e: Exception) {
            Log.w(TAG, "image preload: could not start $url", e) // never break a list for a preload
            return
        }
        // A request that ended inside enqueue (an early error) has called its listener already: don't keep it. The
        // listener runs on the main thread, as this does, so it can't come between this check and the put.
        if (!disposable.job.isCompleted) pending[url] = Job(owner, instance, disposable)
    }

    private fun finished(url: String, ok: Boolean) {
        pending.remove(url)
        if (ok) done[url] = true
    }

    private fun dropGone(owner: String) {
        val it = pending.entries.iterator()
        while (it.hasNext()) {
            val e = it.next()
            if (e.value.owner == owner && ZnStore.find(e.value.instance) == null) {
                e.value.disposable.dispose()
                it.remove()
            }
        }
    }

    private fun dataSaverOn(app: Context): Boolean {
        val now = SystemClock.uptimeMillis()
        if (now - dataSaverAt >= DATA_SAVER_CHECK_MS) {
            dataSaverAt = now
            dataSaver = try {
                app.getSystemService(ConnectivityManager::class.java)?.restrictBackgroundStatus ==
                    ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED
            } catch (e: Exception) {
                false
            }
        }
        return dataSaver
    }

    /** Low memory: stop the preloads and pause them for a minute (the pictures on screen still load). */
    private fun watch(app: Context) {
        if (watching) return
        watching = true
        app.registerComponentCallbacks(object : ComponentCallbacks2 {
            override fun onTrimMemory(level: Int) {
                @Suppress("DEPRECATION")
                if (level == ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN || level < ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) return
                pause("trim memory $level")
            }

            override fun onConfigurationChanged(newConfig: Configuration) {}

            @Deprecated("Deprecated in Java")
            override fun onLowMemory() = pause("low memory")
        })
    }

    private fun pause(why: String) {
        pausedUntil = SystemClock.uptimeMillis() + LOW_MEMORY_PAUSE_MS
        if (pending.isEmpty()) return
        Log.i(TAG, "image preload: $why, ${pending.size} stopped, paused for a minute")
        for (j in pending.values) j.disposable.dispose()
        pending.clear()
    }
}
