package dev.zeronative.plugins.location

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Address
import android.location.Geocoder
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import androidx.core.location.LocationListenerCompat
import androidx.core.location.LocationManagerCompat
import androidx.core.location.LocationRequestCompat
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.ResolvableApiException
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.LocationSettingsRequest
import com.google.android.gms.location.Priority
import dev.zeronative.plugins.location.LocationRules.Accuracy
import dev.zeronative.plugins.location.LocationRules.Fix
import dev.zeronative.runtime.ZnActivity
import dev.zeronative.runtime.ZnCall
import dev.zeronative.runtime.ZnInvalidArgs
import dev.zeronative.runtime.ZnLaunch
import dev.zeronative.runtime.ZnModuleBase
import dev.zeronative.runtime.double
import dev.zeronative.runtime.doubleOrNull
import dev.zeronative.runtime.intOrNull
import dev.zeronative.runtime.longOrNull
import dev.zeronative.runtime.string
import dev.zeronative.runtime.stringOrNull
import java.io.IOException
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject
import android.Manifest.permission.ACCESS_COARSE_LOCATION as COARSE
import android.Manifest.permission.ACCESS_FINE_LOCATION as FINE

/**
 * The device's location, from Android's own LocationManager. JS side: plugins/location/src/index.ts. Play services is used
 * for one thing only: Google's "turn on location" dialog ([turnOn]). Without it, that call answers "unavailable".
 *
 * Every request ends by itself: a one-shot at its timeout (60 s at most), a watch when JS stops it, its screen closes or
 * new JS takes over. Nothing runs while the app is hidden: watches pause, one-shots answer. Coordinates and addresses are
 * private: they never go in a log line, not even in debug builds.
 */
class LocationModule(private val context: Context) : ZnModuleBase("Location", version = 2) { // 2: turnOn
    private val main = Handler(Looper.getMainLooper())
    private val executor = ContextCompat.getMainExecutor(context)
    private val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager?

    // Main thread only, all of it.
    private val asks = LinkedHashSet<Ask>()
    private val watches = LinkedHashMap<String, Watch>()
    /** Between the Activity's start and stop. Before the first start (a background task) the app is not in front. */
    private var inFront = false

    private inner class Ask(val call: ZnCall, val accuracy: Accuracy, val startMs: Long, val precise: Boolean) {
        val listeners = ArrayList<LocationListenerCompat>()
        var best: Location? = null
        val timeUp = Runnable { endAsk(this, "timeout") }
    }

    private inner class Watch(val id: String, val call: ZnCall, val accuracy: Accuracy, val intervalMs: Long, val distanceM: Float) {
        var providers: List<String> = emptyList()
        val listeners = ArrayList<LocationListenerCompat>()
        var last: Fix? = null
        var offSent = false
    }

    init {
        function("providers", onMain = true) { call -> call.resolve(providers()) }

        function("lastKnown", onMain = true) { call -> call.resolve(lastKnown()?.let(::toJson) ?: JSONObject.NULL) }

        // Answers { position, reason, lastKnown }, never rejects for a location reason.
        function("current", onMain = true) { call ->
            val accuracy = accuracyArg(call)
            val timeout = LocationRules.timeoutMs(call.longOrNull("timeoutMs"))
            val maxAge = LocationRules.maxAgeMs(call.longOrNull("maxAgeMs"))
            current(call, accuracy, timeout, maxAge)
        }

        // Runs until JS cancels the call (stop, the screen closes). Fixes come as the event "watch" with this id. It
        // answers only if the watch can't run at all: { reason }.
        function("watch", onMain = true) { call ->
            val id = call.string("id")
            val accuracy = accuracyArg(call)
            val interval = LocationRules.intervalMs(call.longOrNull("intervalMs"))
            val distance = LocationRules.distanceM(call.doubleOrNull("distanceFilterM"))
            startWatch(Watch(id, call, accuracy, interval, distance))
        }

        // Google's "turn on location" dialog. Answers { on: true } (already on, or Play services says it is fine),
        // { on: false, launched: true } (the dialog opened: its answer comes through `launches`), or { on: false, reason }.
        function("turnOn", onMain = true) { call -> turnOn(call, call.string("id")) }

        function("openSettings", onMain = true) { call ->
            val activity = ZnActivity.current
            val intent = Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)
            try {
                if (activity != null) activity.startActivity(intent) else context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                call.resolve(true)
            } catch (e: ActivityNotFoundException) {
                Log.w(TAG, "location: no settings screen", e)
                call.resolve(false)
            }
        }

        // On the I/O pool: Geocoder can block on the network.
        function("reverseGeocode") { call ->
            val latitude = call.double("latitude")
            val longitude = call.double("longitude")
            val max = LocationRules.geocodeMax(call.intOrNull("max"))
            if (!LocationRules.valid(latitude, longitude)) return@function call.resolve(geocoded(null, "invalid"))
            call.resolve(geocode(GeocodeAsk(null, latitude, longitude, max)))
        }

        function("geocode") { call ->
            val query = call.string("query").trim()
            val max = LocationRules.geocodeMax(call.intOrNull("max"))
            if (query.isEmpty()) return@function call.resolve(geocoded(null, "invalid"))
            call.resolve(geocode(GeocodeAsk(query, 0.0, 0.0, max)))
        }
    }

    private fun accuracyArg(call: ZnCall): Accuracy {
        val name = call.stringOrNull("accuracy")
        return LocationRules.accuracy(name) ?: throw ZnInvalidArgs("\"accuracy\" must be \"high\", \"balanced\" or \"low\", not \"$name\"")
    }

    // ---- What the phone allows --------------------------------------------------------------------------------------

    private fun granted(permission: String) = ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    private fun has(): Set<String> = manager?.allProviders?.toSet() ?: emptySet()

    private fun on(): Set<String> = has().filter { p -> runCatching { manager!!.isProviderEnabled(p) }.getOrDefault(false) }.toSet()

    private fun enabled() = manager?.let { LocationManagerCompat.isLocationEnabled(it) } ?: false

    private fun providers(): JSONObject {
        val has = has()
        val on = on()
        return JSONObject()
            .put("enabled", enabled())
            .put("gps", LocationRules.GPS in on)
            .put("network", LocationRules.NETWORK in on)
            .put("hasGps", LocationRules.GPS in has)
            .put("hasNetwork", LocationRules.NETWORK in has)
            .put("fine", granted(FINE))
            .put("coarse", granted(COARSE))
    }

    /** The newest real cached fix any allowed provider has, or null. */
    @SuppressLint("MissingPermission")
    private fun lastKnown(): Location? {
        val lm = manager ?: return null
        val fine = granted(FINE)
        val coarse = granted(COARSE)
        if (!fine && !coarse) return null
        val names = listOfNotNull(LocationRules.GPS.takeIf { fine }, LocationRules.NETWORK, LocationManager.PASSIVE_PROVIDER).filter { it in has() }
        val found = names.mapNotNull { p ->
            try {
                lm.getLastKnownLocation(p)?.takeIf { LocationRules.valid(it.latitude, it.longitude) }
            } catch (e: SecurityException) {
                null
            } catch (e: IllegalArgumentException) {
                null
            }
        }
        val newest = LocationRules.newest(found.map(::toFix)) ?: return null
        return found.first { toFix(it) == newest }
    }

    // ---- One fix ----------------------------------------------------------------------------------------------------

    @SuppressLint("MissingPermission")
    private fun current(call: ZnCall, accuracy: Accuracy, timeoutMs: Long, maxAgeMs: Long) {
        val lm = manager
        val fine = granted(FINE)
        val coarse = granted(COARSE)
        val cached = lastKnown()
        val nowMs = SystemClock.elapsedRealtime()
        if (LocationRules.cachedOk(cached?.let(::toFix), nowMs, maxAgeMs)) {
            Log.i(TAG, "location: ask answered from cache")
            return call.resolve(answer(cached, null, null))
        }
        val providers = if (lm == null) emptyList() else LocationRules.providers(accuracy, fine, coarse, has(), on(), onlyOn = true)
        LocationRules.cantStart(fine, coarse, enabled(), providers, inFront)?.let { reason ->
            Log.i(TAG, "location: ask refused ($reason)")
            return call.resolve(answer(null, reason, cached))
        }
        val ask = Ask(call, accuracy, nowMs, precise = fine)
        asks += ask
        Log.i(TAG, "location: ask on ${providers.joinToString(",")} (${accuracy.name.lowercase()})")
        main.postDelayed(ask.timeUp, timeoutMs)
        call.onCancel { main.post { endAsk(ask, "cancelled") } }
        val request = LocationRequestCompat.Builder(1_000L)
            .setQuality(quality(accuracy))
            .setMinUpdateIntervalMillis(0L)
            .setDurationMillis(timeoutMs)
            .build()
        for (p in providers) {
            val listener = object : LocationListenerCompat {
                override fun onLocationChanged(location: Location) = onAskFix(ask, location)
                override fun onProviderDisabled(provider: String) {}
                override fun onProviderEnabled(provider: String) {}
            }
            try {
                LocationManagerCompat.requestLocationUpdates(lm!!, p, request, executor, listener)
                ask.listeners += listener
            } catch (e: SecurityException) {
                Log.w(TAG, "location: $p refused the request", e)
            } catch (e: IllegalArgumentException) {
                Log.w(TAG, "location: no provider $p", e)
            }
        }
        if (ask.listeners.isEmpty()) endAsk(ask, if (!granted(FINE) && !granted(COARSE)) "denied" else "unavailable")
    }

    private fun onAskFix(ask: Ask, location: Location) {
        if (ask !in asks || !LocationRules.valid(location.latitude, location.longitude)) return
        val fix = toFix(location)
        if (!LocationRules.fresh(fix, ask.startMs, ask.precise)) return
        val best = ask.best
        if (best == null || LocationRules.better(toFix(best), fix) === fix) ask.best = location
        if (LocationRules.goodEnough(fix, ask.accuracy, ask.precise)) endAsk(ask, "fix ${fix.provider}")
    }

    /** Ends a one-shot once. With any fix seen it answers the best one; else [why] is the reason. */
    private fun endAsk(ask: Ask, why: String) {
        if (!asks.remove(ask)) return
        main.removeCallbacks(ask.timeUp)
        remove(ask.listeners)
        val best = ask.best
        Log.i(TAG, "location: ask off ($why${if (best != null && !why.startsWith("fix")) ", best so far" else ""})")
        ask.call.resolve(if (best != null) answer(best, null, null) else answer(null, why, lastKnown()))
    }

    private fun answer(position: Location?, reason: String?, lastKnown: Location?) = JSONObject()
        .put("position", position?.let(::toJson) ?: JSONObject.NULL)
        .put("reason", reason ?: JSONObject.NULL)
        .put("lastKnown", lastKnown?.let(::toJson) ?: JSONObject.NULL)

    // ---- Updates ----------------------------------------------------------------------------------------------------

    private fun startWatch(w: Watch) {
        watches.remove(w.id)?.let { stopWatch(it, "replaced") }
        val fine = granted(FINE)
        val coarse = granted(COARSE)
        if (!fine && !coarse) return w.call.resolve(JSONObject().put("reason", "denied"))
        w.providers = if (manager == null) emptyList() else LocationRules.providers(w.accuracy, fine, coarse, has(), on(), onlyOn = false)
        if (w.providers.isEmpty()) return w.call.resolve(JSONObject().put("reason", "unavailable"))
        watches[w.id] = w
        w.call.onCancel { main.post { if (watches[w.id] === w) stopWatch(w, "stopped") } }
        Log.i(TAG, "location: watch ${w.id} on ${w.providers.joinToString(",")} (${w.accuracy.name.lowercase()}, ${w.intervalMs} ms)")
        if (inFront) listen(w) else Log.i(TAG, "location: watch ${w.id} paused")
        if (!enabled()) sendOff(w)
    }

    @SuppressLint("MissingPermission")
    private fun listen(w: Watch) {
        val lm = manager ?: return
        val request = LocationRequestCompat.Builder(w.intervalMs)
            .setQuality(quality(w.accuracy))
            .setMinUpdateIntervalMillis(w.intervalMs / 2)
            .setMinUpdateDistanceMeters(w.distanceM)
            .build()
        for (p in w.providers) {
            val listener = object : LocationListenerCompat {
                override fun onLocationChanged(location: Location) = onWatchFix(w, location)
                override fun onProviderEnabled(provider: String) {
                    w.offSent = false
                }
                override fun onProviderDisabled(provider: String) {
                    if (w.providers.none { it in on() }) sendOff(w)
                }
            }
            try {
                LocationManagerCompat.requestLocationUpdates(lm, p, request, executor, listener)
                w.listeners += listener
            } catch (e: SecurityException) {
                Log.w(TAG, "location: $p refused the watch", e)
            } catch (e: IllegalArgumentException) {
                Log.w(TAG, "location: no provider $p", e)
            }
        }
        // The permission was taken away while the app was hidden: Android killed the process then, so this is rare.
        if (w.listeners.isEmpty()) {
            stopWatch(w, "denied")
            w.call.resolve(JSONObject().put("reason", "denied"))
        }
    }

    private fun onWatchFix(w: Watch, location: Location) {
        if (watches[w.id] !== w || !LocationRules.valid(location.latitude, location.longitude)) return
        val fix = toFix(location)
        if (!LocationRules.watchKeeps(w.last, fix, w.intervalMs)) return
        w.last = fix
        w.offSent = false
        emit("watch", JSONObject().put("id", w.id).put("position", toJson(location)).put("reason", JSONObject.NULL))
    }

    private fun sendOff(w: Watch) {
        if (w.offSent) return
        w.offSent = true
        Log.i(TAG, "location: watch ${w.id} sees location off")
        emit("watch", JSONObject().put("id", w.id).put("position", JSONObject.NULL).put("reason", "off"))
    }

    private fun pause(w: Watch) = remove(w.listeners)

    /** Android marks removeUpdates as needing the permission. It works without it, but a phone could still throw. */
    @SuppressLint("MissingPermission")
    private fun remove(listeners: MutableList<LocationListenerCompat>) {
        val lm = manager
        for (listener in listeners) {
            try {
                if (lm != null) LocationManagerCompat.removeUpdates(lm, listener)
            } catch (e: SecurityException) {
                Log.w(TAG, "location: removeUpdates refused", e)
            }
        }
        listeners.clear()
    }

    private fun stopWatch(w: Watch, why: String) {
        if (watches[w.id] === w) watches.remove(w.id)
        pause(w)
        Log.i(TAG, "location: watch ${w.id} off ($why)")
    }

    // ---- Turning location on ----------------------------------------------------------------------------------------

    /** Main thread. Every way out answers [call] once: Play services' answer, its failure, or our own timer. */
    private fun turnOn(call: ZnCall, id: String) {
        if (enabled()) return call.resolve(JSONObject().put("on", true))
        val activity = ZnActivity.current ?: return call.resolve(turnedOff("no_activity"))
        var done = false
        lateinit var giveUp: Runnable
        fun finish(answer: JSONObject) {
            if (done) return
            done = true
            main.removeCallbacks(giveUp)
            call.resolve(answer)
        }
        giveUp = Runnable {
            Log.w(TAG, "location: Play services didn't answer the settings check")
            finish(turnedOff("unavailable"))
        }
        main.postDelayed(giveUp, LocationRules.TURN_ON_ASK_MS)
        val request = LocationSettingsRequest.Builder()
            .addLocationRequest(LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, 10_000L).build())
            .setAlwaysShow(true) // the dialog even if the user said "never" to it before, as the RN app does
            .build()
        try {
            LocationServices.getSettingsClient(activity).checkLocationSettings(request)
                .addOnSuccessListener { finish(if (enabled()) JSONObject().put("on", true) else turnedOff("unavailable")) }
                .addOnFailureListener { e ->
                    val resolvable = e as? ResolvableApiException
                    val code = (e as? ApiException)?.statusCode ?: -1
                    if (LocationRules.turnOnStep(code, resolvable != null) != "dialog") {
                        Log.w(TAG, "location: no turn-on dialog (status $code)")
                        return@addOnFailureListener finish(turnedOff("unavailable"))
                    }
                    if (done) return@addOnFailureListener // our timer answered: a dialog now would answer nobody
                    if (call.isCancelled) return@addOnFailureListener finish(turnedOff("failed"))
                    val started = try {
                        ZnLaunch.start(LocationRules.TURN_ON_KEY, id, resolvable!!.resolution.intentSender)
                    } catch (t: Throwable) {
                        Log.w(TAG, "location: can't open the turn-on dialog", t)
                        ZnLaunch.Started(false, "failed")
                    }
                    if (started.launched) Log.i(TAG, "location: turn-on dialog open")
                    finish(if (started.launched) JSONObject().put("on", false).put("launched", true) else turnedOff(started.reason ?: "failed"))
                }
                .addOnCanceledListener { finish(turnedOff("unavailable")) }
        } catch (t: Throwable) { // no Play services library at run time, or it threw at once
            Log.w(TAG, "location: can't ask Play services", t)
            finish(turnedOff("unavailable"))
        }
    }

    private fun turnedOff(reason: String) = JSONObject().put("on", false).put("reason", reason)

    // ---- The app's state --------------------------------------------------------------------------------------------

    internal fun onFront() {
        inFront = true
        for (w in watches.values.toList()) {
            if (w.listeners.isEmpty()) {
                Log.i(TAG, "location: watch ${w.id} resumed")
                listen(w)
            }
        }
    }

    /** A hidden app gets no fix: a one-shot answers now, with the best fix so far, and watches stop asking until onFront. */
    internal fun onBack() {
        inFront = false
        for (ask in asks.toList()) endAsk(ask, "background")
        for (w in watches.values) {
            if (w.listeners.isNotEmpty()) Log.i(TAG, "location: watch ${w.id} paused")
            pause(w)
        }
    }

    /** New JS took over: nobody hears these answers, so stop everything now. */
    internal fun onRuntimeReplaced() {
        for (ask in asks.toList()) endAsk(ask, "replaced")
        for (w in watches.values.toList()) stopWatch(w, "js replaced")
    }

    // ---- Geocoder ---------------------------------------------------------------------------------------------------

    /** A place name to look up ([query]), or else a point. */
    private class GeocodeAsk(val query: String?, val latitude: Double, val longitude: Double, val max: Int)

    /** I/O pool. Android 13+ answers through a listener; before that the call blocks. */
    private fun geocode(ask: GeocodeAsk): JSONObject {
        if (!Geocoder.isPresent()) return geocoded(null, "unavailable")
        val geocoder = Geocoder(context, Locale.getDefault())
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                geocodeWithListener(geocoder, ask)
            } else {
                @Suppress("DEPRECATION")
                val found = if (ask.query != null) geocoder.getFromLocationName(ask.query, ask.max) else geocoder.getFromLocation(ask.latitude, ask.longitude, ask.max)
                geocoded(found?.take(ask.max), null)
            }
        } catch (e: IOException) {
            Log.w(TAG, "location: geocoder failed (${e::class.java.simpleName})") // not the message: it can hold the query
            geocoded(null, "failed")
        } catch (e: IllegalArgumentException) {
            geocoded(null, "invalid")
        }
    }

    /** Waits at most [GEOCODE_WAIT_S]: the listener may never be called if the geocoder's service hangs. */
    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    private fun geocodeWithListener(geocoder: Geocoder, ask: GeocodeAsk): JSONObject {
        val done = CountDownLatch(1)
        var found: List<Address>? = null
        var failed = false
        val listener = object : Geocoder.GeocodeListener {
            override fun onGeocode(addresses: MutableList<Address>) {
                found = addresses.toList()
                done.countDown()
            }
            override fun onError(errorMessage: String?) {
                failed = true
                done.countDown()
            }
        }
        if (ask.query != null) geocoder.getFromLocationName(ask.query, ask.max, listener) else geocoder.getFromLocation(ask.latitude, ask.longitude, ask.max, listener)
        return when {
            !done.await(GEOCODE_WAIT_S, TimeUnit.SECONDS) -> geocoded(null, "timeout")
            failed -> geocoded(null, "failed")
            else -> geocoded(found?.take(ask.max), null)
        }
    }

    private fun geocoded(addresses: List<Address>?, reason: String?): JSONObject {
        val list = JSONArray()
        addresses?.forEach { list.put(toJson(it)) }
        val why = reason ?: if (list.length() == 0) "none" else null
        return JSONObject().put("addresses", list).put("reason", why ?: JSONObject.NULL)
    }

    // ---- Shapes -----------------------------------------------------------------------------------------------------

    private fun quality(accuracy: Accuracy) = when (accuracy) {
        Accuracy.HIGH -> LocationRequestCompat.QUALITY_HIGH_ACCURACY
        Accuracy.BALANCED -> LocationRequestCompat.QUALITY_BALANCED_POWER_ACCURACY
        Accuracy.LOW -> LocationRequestCompat.QUALITY_LOW_POWER
    }

    private fun toFix(l: Location) = Fix(
        l.latitude,
        l.longitude,
        if (l.hasAccuracy()) l.accuracy else null,
        l.provider ?: "",
        l.elapsedRealtimeNanos / 1_000_000,
    )

    private fun toJson(l: Location): JSONObject {
        val mocked = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) l.isMock else @Suppress("DEPRECATION") l.isFromMockProvider
        val verticalAccuracy = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && l.hasVerticalAccuracy()) l.verticalAccuracyMeters.toDouble() else null
        return JSONObject()
            .put("latitude", l.latitude)
            .put("longitude", l.longitude)
            .put("accuracy", if (l.hasAccuracy()) l.accuracy.toDouble() else JSONObject.NULL)
            .put("altitude", if (l.hasAltitude()) l.altitude else JSONObject.NULL)
            .put("altitudeAccuracy", verticalAccuracy ?: JSONObject.NULL)
            .put("heading", if (l.hasBearing()) l.bearing.toDouble() else JSONObject.NULL)
            .put("speed", if (l.hasSpeed()) l.speed.toDouble() else JSONObject.NULL)
            .put("timestamp", l.time)
            .put("ageMs", (SystemClock.elapsedRealtime() - l.elapsedRealtimeNanos / 1_000_000).coerceAtLeast(0L))
            .put("provider", l.provider ?: "")
            .put("mocked", mocked)
    }

    private fun toJson(a: Address): JSONObject {
        fun s(v: String?): Any = v ?: JSONObject.NULL
        val name = a.subLocality ?: a.locality ?: a.subAdminArea ?: a.adminArea ?: a.featureName
        return JSONObject()
            .put("name", s(name))
            .put("line", s(if (a.maxAddressLineIndex >= 0) a.getAddressLine(0) else null))
            .put("area", s(a.subLocality))
            .put("city", s(a.locality))
            .put("district", s(a.subAdminArea))
            .put("state", s(a.adminArea))
            .put("postalCode", s(a.postalCode))
            .put("country", s(a.countryName))
            .put("countryCode", s(a.countryCode))
            .put("latitude", if (a.hasLatitude()) a.latitude else JSONObject.NULL)
            .put("longitude", if (a.hasLongitude()) a.longitude else JSONObject.NULL)
    }

    private companion object {
        const val TAG = "zn"
        const val GEOCODE_WAIT_S = 10L
    }
}
