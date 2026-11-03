package dev.zeronative.plugins.auth

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import com.google.android.gms.auth.api.identity.GetPhoneNumberHintIntentRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.auth.api.phone.SmsRetriever
import com.google.android.gms.common.api.Status
import dev.zeronative.runtime.ZnActivity
import dev.zeronative.runtime.ZnCall
import dev.zeronative.runtime.ZnLaunch
import dev.zeronative.runtime.ZnModuleBase
import dev.zeronative.runtime.longOrNull
import dev.zeronative.runtime.string
import dev.zeronative.runtime.stringOrNull
import org.json.JSONObject

/**
 * The phone number hint and the SMS Retriever. JS side: plugins/auth/src/index.ts.
 *
 * Any Play services failure is a clean answer that means "type it by hand", never a crash and never a wait with no end.
 * An OTP is secret and a phone number is private: neither goes in a log line, not even in debug builds.
 */
class AuthModule(private val context: Context) : ZnModuleBase("Auth", version = 1) {
    private val main = Handler(Looper.getMainLooper())
    private val hint = Latest<HintAsk>()
    private val otp = Latest<OtpListen>()

    /** A hint we asked Play services for. The sheet opens only if this is still the waiting one when the answer comes. */
    private inner class HintAsk(val call: ZnCall, val id: String) {
        val giveUp = Runnable { refuseHint(this, "unavailable") }
    }

    /** One wait for an SMS. It ends once, in [answerOtp] or [onRuntimeReplaced]; both drop the timer and the receiver. */
    private inner class OtpListen(val id: String, val pattern: Regex) {
        var receiver: BroadcastReceiver? = null
        val timeUp = Runnable { answerOtp(this, null, "timeout") }
    }

    init {
        // The answer says if the sheet opened. What the user picked comes through `launches`, so it survives a kill.
        function("phoneHint", onMain = true) { call -> askHint(HintAsk(call, call.string("id"))) }

        // Answers at once. The outcome comes as the event "otp". A new listen answers the one before it.
        function("listenOtp", onMain = true) { call ->
            val id = call.string("id")
            val wait = AuthRules.waitMs(call.longOrNull("timeoutMs"))
            val pattern = AuthRules.pattern(call.stringOrNull("pattern"))
            otp.current?.let { answerOtp(it, null, "replaced") }
            if (pattern == null) {
                Log.w(TAG, "auth: the SMS pattern is not valid")
                send(id, null, "bad_pattern")
            } else {
                listen(OtpListen(id, pattern), wait)
            }
            call.resolve(true)
        }

        function("stopOtp", onMain = true) { call ->
            otp.current?.let { answerOtp(it, null, "cancelled") }
            call.resolve(true)
        }

        function("appHash") { call ->
            val hash = try {
                readAppHash()
            } catch (t: Throwable) {
                Log.w(TAG, "auth: the app hash can't be read", t)
                ""
            }
            call.resolve(hash)
        }
    }

    // ---- The phone number hint --------------------------------------------------------------------------------------

    /** Main thread. Any failure refuses the call, and the screen goes on with the typed number. */
    private fun askHint(ask: HintAsk) {
        hint.begin(ask)?.let { old ->
            main.removeCallbacks(old.giveUp)
            old.call.resolve(ZnLaunch.Started(false, "replaced").toJson())
        }
        // Play services can be slow to answer, or busy updating itself: a Task may never finish.
        main.postDelayed(ask.giveUp, AuthRules.HINT_ASK_MS)
        val activity = ZnActivity.current ?: return refuseHint(ask, "no_activity")
        try {
            val request = GetPhoneNumberHintIntentRequest.builder().build()
            Identity.getSignInClient(activity).getPhoneNumberHintIntent(request)
                .addOnSuccessListener { pending -> openHint(ask, pending) }
                .addOnFailureListener { e ->
                    Log.w(TAG, "auth: no phone number hint: ${e.message}")
                    refuseHint(ask, "unavailable")
                }
                .addOnCanceledListener { refuseHint(ask, "unavailable") }
        } catch (t: Throwable) {
            Log.w(TAG, "auth: can't ask for the phone number hint", t)
            refuseHint(ask, "unavailable")
        }
    }

    private fun openHint(ask: HintAsk, pending: PendingIntent) {
        if (!hint.end(ask)) return
        main.removeCallbacks(ask.giveUp)
        if (ask.call.isCancelled) return // the JS that asked is gone: a sheet now would answer nobody
        val started = try {
            ZnLaunch.start(AuthRules.HINT_KEY, ask.id, pending.intentSender)
        } catch (t: Throwable) {
            Log.w(TAG, "auth: can't open the phone number hint", t)
            ZnLaunch.Started(false, "failed")
        }
        ask.call.resolve(started.toJson())
    }

    private fun refuseHint(ask: HintAsk, reason: String) {
        if (!hint.end(ask)) return
        main.removeCallbacks(ask.giveUp)
        ask.call.resolve(ZnLaunch.Started(false, reason).toJson())
    }

    /** Main thread, from ZnLaunch, also in a new process after a kill. Becomes the launch record's extras, on disk until JS acks. */
    internal fun readHint(resultCode: Int, data: Intent?): JSONObject {
        val answer = AuthRules.hintAnswer(resultCode, data != null) {
            Identity.getSignInClient(context).getPhoneNumberFromIntent(data!!)
        }
        val out = JSONObject()
        answer.phone?.let { out.put("phone", it) }
        answer.reason?.let { out.put("reason", it) }
        return out
    }

    // ---- The SMS Retriever ------------------------------------------------------------------------------------------

    /** Main thread. */
    private fun listen(listen: OtpListen, wait: Long) {
        otp.begin(listen)
        Log.i(TAG, "auth: otp listener on")
        // Our own timer too: if Play services never sends TIMEOUT, or wait is short, the screen must still get its answer.
        main.postDelayed(listen.timeUp, wait)
        try {
            SmsRetriever.getClient(context).startSmsRetriever()
                .addOnSuccessListener { if (otp.current === listen) addReceiver(listen) }
                .addOnFailureListener { e ->
                    Log.w(TAG, "auth: the SMS Retriever didn't start: ${e.message}")
                    answerOtp(listen, null, "unavailable")
                }
                .addOnCanceledListener { answerOtp(listen, null, "unavailable") }
        } catch (t: Throwable) {
            Log.w(TAG, "auth: can't start the SMS Retriever", t)
            answerOtp(listen, null, "unavailable")
        }
    }

    /**
     * On the application context, so an SMS still counts while the user is in another app or the Activity is rebuilt.
     * Exported, because Play services is another app. The permission means only Play services can send it, so no other
     * app can feed us a fake OTP. Don't drop it.
     */
    private fun addReceiver(listen: OtpListen) {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, intent: Intent?) = onSms(listen, intent)
        }
        try {
            ContextCompat.registerReceiver(
                context,
                receiver,
                IntentFilter(SmsRetriever.SMS_RETRIEVED_ACTION),
                SmsRetriever.SEND_PERMISSION,
                null,
                ContextCompat.RECEIVER_EXPORTED,
            )
            listen.receiver = receiver
        } catch (t: Throwable) {
            Log.w(TAG, "auth: can't add the SMS receiver", t)
            answerOtp(listen, null, "unavailable")
        }
    }

    private fun onSms(listen: OtpListen, intent: Intent?) {
        if (SmsRetriever.SMS_RETRIEVED_ACTION != intent?.action) return
        val answer = try {
            val extras = intent.extras ?: return
            val status = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                extras.getParcelable(SmsRetriever.EXTRA_STATUS, Status::class.java)
            } else {
                @Suppress("DEPRECATION")
                extras.getParcelable(SmsRetriever.EXTRA_STATUS)
            } ?: return
            AuthRules.otpAnswer(status.statusCode, extras.getString(SmsRetriever.EXTRA_SMS_MESSAGE), listen.pattern)
        } catch (t: Throwable) {
            // Only the type: this was reading the SMS, and the message of an exception could carry part of it.
            Log.w(TAG, "auth: the SMS can't be read: ${t::class.java.simpleName}")
            AuthRules.OtpAnswer(null, "failed")
        }
        answerOtp(listen, answer.code, answer.reason)
    }

    private fun answerOtp(listen: OtpListen, code: String?, reason: String?) {
        if (!otp.end(listen)) return
        stop(listen, reason ?: "code")
        send(listen.id, code, reason)
    }

    private fun send(id: String, code: String?, reason: String?) {
        emit("otp", JSONObject().put("id", id).put("code", code ?: JSONObject.NULL).put("reason", reason ?: JSONObject.NULL))
    }

    /** [why] goes in the log, so it must never be the code. */
    private fun stop(listen: OtpListen, why: String) {
        main.removeCallbacks(listen.timeUp)
        listen.receiver?.let {
            try {
                context.unregisterReceiver(it)
            } catch (e: IllegalArgumentException) {
                Log.w(TAG, "auth: the SMS receiver was not registered", e)
            }
        }
        listen.receiver = null
        Log.i(TAG, "auth: otp listener off ($why)")
    }

    /** New JS took over: the JS that asked is gone, and the receiver sits on the application context, so nothing else stops it. */
    internal fun onRuntimeReplaced() {
        hint.current?.let { refuseHint(it, "replaced") }
        otp.current?.let {
            otp.end(it)
            stop(it, "js replaced")
        }
    }

    // ---- The app hash -----------------------------------------------------------------------------------------------

    private fun readAppHash(): String {
        val signature = appSignatures()?.firstOrNull() ?: return ""
        return AuthRules.appHash(context.packageName, signature.toCharsString()) {
            Base64.encodeToString(it, Base64.NO_PADDING or Base64.NO_WRAP)
        }
    }

    private fun appSignatures(): Array<Signature>? {
        val packages = context.packageManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val signing = packages.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES).signingInfo
            return when {
                signing == null -> null
                signing.hasMultipleSigners() -> signing.apkContentsSigners
                else -> signing.signingCertificateHistory
            }
        }
        @Suppress("DEPRECATION")
        return packages.getPackageInfo(context.packageName, PackageManager.GET_SIGNATURES).signatures
    }

    private companion object {
        const val TAG = "zn"
    }
}
