package dev.zeronative.runtime

import android.content.Context
import android.util.Log

/**
 * A plugin: one package with TS and an Android library (docs/plugins.md, docs/guide-notes.md §30). The app turns it on
 * with one line, [ZnPlugins.register].
 */
interface ZnPlugin {
    /** Called once, on the main thread, in Application.onCreate. Only declare things here: no I/O, no slow work. */
    fun register(r: ZnPluginRegistry)
}

/** What a plugin adds, in [ZnPlugin.register]. Anything wrong here throws, and [ZnPlugins.register] handles it. */
class ZnPluginRegistry internal constructor(
    private val appContext: () -> Context,
    private val hostApi: Int,
    private val nameTaken: (String) -> Boolean,
) {
    internal val modules = ArrayList<ZnModule>()
    internal val events = ArrayList<ZnActivityEvents>()
    internal val screens = HashMap<String, ZnScreenContent>()
    internal val views = HashMap<String, ZnViewContent>()

    /** The Application, safe to keep. */
    val context: Context get() = appContext()

    /** Adds a native module. Its name must be free: a plugin can't replace a built-in module or another plugin's. */
    fun module(module: ZnModule) {
        check(!nameTaken(module.name) && modules.none { it.name == module.name }) {
            "the native module name \"${module.name}\" is already taken"
        }
        modules += module
    }

    /** Adds a native screen, which a route opens with `native: "<plugin>.<name>"` (docs/plugins.md §5). */
    fun screen(name: String, content: ZnScreenContent) {
        check(!ZnNativeScreens.has(name) && name !in screens) { "the native screen name \"$name\" is already taken" }
        screens[name] = content
    }

    /** Adds a view, which a screen shows with `<NativeView name="<plugin>.<name>" />` (docs/plugins.md §5). */
    fun view(name: String, content: ZnViewContent) {
        check(!ZnNativeViews.has(name) && name !in views) { "the native view name \"$name\" is already taken" }
        views[name] = content
    }

    /** Hears the Activity and the app: new intents, front and back, low memory, new JS. */
    fun activityEvents(events: ZnActivityEvents) {
        this.events += events
    }

    /** This plugin needs at least this host API (`ZnPlugins.HOST_API`). */
    fun requireHostApi(version: Int) {
        check(version <= hostApi) { "it needs host API v$version; this app has v$hostApi" }
    }
}

/**
 * Turns plugins on: `ZnPlugins.register(this, ScannerPlugin())`, first thing in Application.onCreate, before the bundle
 * is chosen (ZnTemplates.preload / ZnRuntime.start). The OTA check compares the modules registered by then with what a
 * downloaded bundle needs (docs/ota.md §3.2).
 *
 * A plugin is added whole or not at all. One that fails stops a debug build at once. A release build logs it, skips that
 * plugin and starts: an update that needs its module is refused by the OTA check, and calls to it are rejected with
 * "unavailable" (docs/second-opinions.md entry 10).
 */
object ZnPlugins {
    private const val TAG = "zn"

    /**
     * The host API of this runtime, the same as kHostApiVersion in core/include/zn/engine.h (a test compares them). A
     * constant, so a plugin's check doesn't load the native library in Application.onCreate.
     */
    const val HOST_API = 9

    fun register(context: Context, vararg plugins: ZnPlugin) {
        val app = context.applicationContext
        for (plugin in plugins) {
            val added = try {
                collect(plugin, { app }, HOST_API, ZnModules::has)
            } catch (e: Throwable) { // Throwable: a missing class or native library is an Error, not an Exception
                val message = "plugin ${plugin::class.java.name} failed: ${e.message ?: e::class.java.simpleName}"
                if (BuildConfig.DEBUG) throw IllegalStateException(message, e)
                Log.e(TAG, "$message; skipped", e)
                continue
            }
            added.modules.forEach(ZnModules::register)
            added.events.forEach(ZnActivity::addEvents)
            added.screens.forEach { (name, content) -> ZnNativeScreens.add(name, content) }
            added.views.forEach { (name, content) -> ZnNativeViews.add(name, content) }
        }
    }

    /** Runs one plugin's [ZnPlugin.register] and returns what it added. Throws if anything in it failed. */
    internal fun collect(plugin: ZnPlugin, context: () -> Context, hostApi: Int, nameTaken: (String) -> Boolean): ZnPluginRegistry {
        val registry = ZnPluginRegistry(context, hostApi, nameTaken)
        plugin.register(registry)
        return registry
    }
}
