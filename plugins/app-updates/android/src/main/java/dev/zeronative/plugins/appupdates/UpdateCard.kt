package dev.zeronative.plugins.appupdates

import android.app.Activity
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.lang.ref.WeakReference

/**
 * The words and colour of the download card (`AppUpdatesPlugin(showCard = true, cardTexts = ...)`). Plain words by
 * default; an app passes its own (its name, its language, its brand colour).
 */
data class UpdateCardTexts(
    val downloading: String = "Downloading update",
    val ready: String = "Update ready",
    val readyHint: String = "Restart the app to finish updating",
    /** `%d` is the percentage. */
    val progress: String = "%d%% · keep using the app",
    val starting: String = "Starting… · keep using the app",
    val restart: String = "Restart",
    /** The ✕ button, for TalkBack. */
    val hide: String = "Hide",
    /** The Restart button and the progress bar (ARGB). */
    val color: Int = 0xFF1A73E8.toInt(),
)

/** The card's state (pure, so a JVM unit test can check it). Same as RN's `UpdateCardState`. */
internal data class UpdateCardState(
    val phase: Phase = Phase.IDLE,
    /** 0..1, or null while unknown (Play sends no sizes yet). */
    val progress: Float? = null,
    val hiddenByUser: Boolean = false,
) {
    enum class Phase { IDLE, DOWNLOADING, DOWNLOADED }

    fun visible(busy: Boolean): Boolean = phase != Phase.IDLE && !hiddenByUser && !busy

    /** Next state for a Play install status (the same names as the JS `state` event). */
    fun onStatus(status: String, bytesDownloaded: Long, totalBytes: Long): UpdateCardState = when (status) {
        // A new download shows the card again; a running one keeps the user's ✕
        "accepted", "pending" ->
            if (phase == Phase.DOWNLOADED) this
            else copy(phase = Phase.DOWNLOADING, hiddenByUser = hiddenByUser && phase == Phase.DOWNLOADING)
        "downloading" ->
            if (phase == Phase.DOWNLOADED) this
            else copy(
                phase = Phase.DOWNLOADING,
                progress = if (totalBytes > 0) (bytesDownloaded.toFloat() / totalBytes).coerceIn(0f, 1f) else null,
                hiddenByUser = hiddenByUser && phase == Phase.DOWNLOADING,
            )
        // Ready: shown again even after ✕
        "downloaded" -> UpdateCardState(Phase.DOWNLOADED, 1f, false)
        "failed", "canceled", "declined" -> UpdateCardState()
        else -> this
    }

    fun hide(): UpdateCardState = copy(hiddenByUser = true)
}

/**
 * The optional (FLEXIBLE) update's download card, drawn natively at the top of the screen. Opt-in
 * (`AppUpdatesPlugin(showCard = true)`). Native, so it follows Play's download with no JS (it survives a JS restart).
 * Ported from ZeroBill's card (itself a port of RN's `ZUpdateCard`).
 *
 * - Downloading: the app icon, "Downloading update", the percentage and a thin progress bar; ✕ hides it until the
 *   download finishes (the download goes on).
 * - Downloaded: "Update ready" with a Restart button (Play installs and restarts the app). It comes back after ✕.
 * - Hidden while the app is busy (JS setBusy): never a restart prompt during a payment. JS still installs a downloaded
 *   update when the user comes back to the app and it is not busy.
 *
 * It sits in the Activity's content view with a high elevation, so it draws over the app's screens. A sheet that is
 * its own window covers it until the sheet closes.
 */
internal object UpdateCard {
    private const val TAG = "zn-app-updates"

    private val main = Handler(Looper.getMainLooper())

    // Set once when the plugin is registered
    @Volatile private var enabled = false
    @Volatile private var texts = UpdateCardTexts()

    // State: written on the main thread only
    private var state = UpdateCardState()
    private var busy = false

    /** Installs the downloaded update (set by the current Activity's helper). */
    @Volatile
    var onRestart: (() -> Unit)? = null

    private var activityRef: WeakReference<Activity>? = null
    private var card: View? = null
    private var title: TextView? = null
    private var subtitle: TextView? = null
    private var bar: ProgressBar? = null
    private var restart: TextView? = null

    fun configure(show: Boolean, cardTexts: UpdateCardTexts) {
        enabled = show
        texts = cardTexts
    }

    /** Every time the app comes to the front: the card belongs to the current Activity (a new Activity gets a new card). */
    fun attach(activity: Activity) {
        if (!enabled) return
        main.post {
            if (activityRef?.get() !== activity) {
                (card?.parent as? ViewGroup)?.removeView(card)
                card = null
                activityRef = WeakReference(activity)
                // A new Activity after a kill during a payment: JS has not said "busy" again yet, the disk has
                busy = AppUpdatesHelper.isBusy(activity)
            }
            render()
        }
    }

    /** Play's install state (the same names as the JS `state` event). */
    fun onState(status: String, bytesDownloaded: Long, totalBytes: Long) {
        if (!enabled) return
        main.post {
            state = state.onStatus(status, bytesDownloaded, totalBytes)
            render()
        }
    }

    fun setBusy(value: Boolean) {
        if (!enabled) return
        main.post {
            if (busy == value) return@post
            busy = value
            render()
        }
    }

    /**
     * Keeps the card 8 dp below the status bar. [statusBarTop] null = read the current insets (the app may use up
     * inset events before they reach the card, so render() also calls this on every draw).
     */
    private fun applyTopInset(activity: Activity, view: View, statusBarTop: Int?) {
        val top = statusBarTop
            ?: ViewCompat.getRootWindowInsets(view)?.getInsets(WindowInsetsCompat.Type.statusBars())?.top
            ?: ViewCompat.getRootWindowInsets(activity.window.decorView)?.getInsets(WindowInsetsCompat.Type.statusBars())?.top
            ?: 0
        val params = view.layoutParams as? FrameLayout.LayoutParams ?: return
        val wanted = top + dp(activity, 8f)
        if (params.topMargin != wanted) {
            params.topMargin = wanted
            view.layoutParams = params
        }
    }

    private fun dp(activity: Activity, value: Float): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, activity.resources.displayMetrics).toInt()

    private fun render() {
        val activity = activityRef?.get() ?: return
        if (activity.isFinishing || activity.isDestroyed) return
        try {
            if (!state.visible(busy)) {
                card?.visibility = View.GONE
                return
            }
            val view = card ?: build(activity).also { card = it }
            applyTopInset(activity, view, null)
            val ready = state.phase == UpdateCardState.Phase.DOWNLOADED
            val progress = state.progress
            title?.text = if (ready) texts.ready else texts.downloading
            subtitle?.text = when {
                ready -> texts.readyHint
                progress != null -> texts.progress.format((progress * 100).toInt())
                else -> texts.starting
            }
            bar?.apply {
                visibility = if (ready) View.GONE else View.VISIBLE
                isIndeterminate = progress == null
                if (progress != null) this.progress = (progress * 1000).toInt()
            }
            restart?.visibility = if (ready) View.VISIBLE else View.GONE
            if (view.visibility != View.VISIBLE) {
                view.visibility = View.VISIBLE
                view.alpha = 0f
                view.translationY = -dp(activity, 12f).toFloat()
                view.animate().alpha(1f).translationY(0f).setDuration(220).start()
            }
        } catch (e: Exception) {
            // The card is a convenience: a drawing problem must never affect the app
            Log.w(TAG, "could not draw the update card", e)
        }
    }

    private fun build(activity: Activity): View {
        val content = activity.findViewById<FrameLayout>(android.R.id.content)
        val pad = dp(activity, 12f)
        val color = texts.color

        val root = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = dp(activity, 16f).toFloat()
                setStroke(dp(activity, 1f), 0xFFE2E8F0.toInt())
            }
            elevation = dp(activity, 12f).toFloat()
            setPadding(pad, pad, dp(activity, 8f), pad)
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        }

        val row = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val icon = ImageView(activity).apply {
            setImageDrawable(activity.applicationInfo.loadIcon(activity.packageManager))
            layoutParams = LinearLayout.LayoutParams(dp(activity, 36f), dp(activity, 36f))
        }
        val textColumn = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = pad }
        }
        val titleView = TextView(activity).apply {
            setTextColor(0xFF0F172A.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            setTypeface(typeface, Typeface.BOLD)
        }
        val subtitleView = TextView(activity).apply {
            setTextColor(0xFF64748B.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        }
        textColumn.addView(titleView)
        textColumn.addView(subtitleView)

        val restartView = TextView(activity).apply {
            text = texts.restart
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setTypeface(typeface, Typeface.BOLD)
            background = GradientDrawable().apply {
                setColor(color)
                cornerRadius = dp(activity, 10f).toFloat()
            }
            setPadding(dp(activity, 14f), dp(activity, 8f), dp(activity, 14f), dp(activity, 8f))
            isClickable = true
            setOnClickListener {
                try {
                    onRestart?.invoke()
                } catch (e: Exception) {
                    Log.w(TAG, "Restart failed", e)
                }
            }
        }
        val close = TextView(activity).apply {
            text = "✕"
            contentDescription = texts.hide
            setTextColor(0xFF94A3B8.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(dp(activity, 40f), dp(activity, 40f))
            isClickable = true
            setOnClickListener {
                state = state.hide()
                render()
            }
        }
        row.addView(icon)
        row.addView(textColumn)
        row.addView(restartView)
        row.addView(close)

        val progressView = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 1000
            progressTintList = ColorStateList.valueOf(color)
            indeterminateTintList = ColorStateList.valueOf(color)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(activity, 4f)).apply {
                topMargin = dp(activity, 10f)
                marginEnd = dp(activity, 4f)
            }
        }
        root.addView(row)
        root.addView(progressView)

        // Below the status bar, with side margins; the top follows the live status bar (applyTopInset)
        root.layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP).apply {
            leftMargin = pad
            rightMargin = pad
        }
        root.visibility = View.GONE
        content.addView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            applyTopInset(activity, v, insets.getInsets(WindowInsetsCompat.Type.statusBars()).top)
            insets
        }
        applyTopInset(activity, root, null)

        title = titleView
        subtitle = subtitleView
        bar = progressView
        restart = restartView
        return root
    }
}
