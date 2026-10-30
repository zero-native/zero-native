package dev.zeronative.runtime

/**
 * What this app can run (the capability manifest, docs/ota.md §3.2, ARCHITECTURE §16.2): the registry version its
 * renderer knows, the Hermes bytecode format, the host API range of its native side, and its native modules with
 * versions. A downloaded bundle runs only if this covers the bundle's `requires` ([ZnBundles]); the update server
 * gets the same facts with each check (step 4.4) so it doesn't offer what the app can't run.
 */
class ZnCapabilities(
    val registry: Int,
    val bytecode: Int,
    val hostApi: Int,
    val hostApiOldest: Int,
    val modules: Map<String, Int>,
) {
    /** Why this app can't run a bundle that needs [req], or null if it can. */
    fun missing(req: ZnBundles.Requires): String? {
        if (req.registry > registry) return "it needs registry v${req.registry}, this app has v$registry"
        if (req.bytecode != bytecode) return "its bytecode is format ${req.bytecode}, this app's Hermes runs format $bytecode"
        if (req.hostApi > hostApi) return "it needs host API v${req.hostApi}, this app has v$hostApi"
        if (req.hostApi < hostApiOldest) {
            return "it was built for host API v${req.hostApi}; this app runs v$hostApiOldest and newer"
        }
        for ((name, version) in req.modules) {
            val have = modules[name] ?: return "it needs native module $name, this app doesn't have it"
            if (have < version) return "it needs $name v$version, this app has v$have"
        }
        return null
    }

    override fun toString() =
        "registry v$registry, bytecode $bytecode, host API v$hostApiOldest–$hostApi, modules $modules"

    companion object {
        /**
         * This app's capabilities now. Native modules registered later are not in it: apps register their modules
         * before the bundle is chosen ([ZnModules.register]).
         */
        internal fun current(): ZnCapabilities {
            val native = ZnNative.capabilities()
            return ZnCapabilities(Registry.VERSION, native[0], native[1], native[2], ZnModules.versions())
        }
    }
}
