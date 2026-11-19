package __APP_ID__

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import dev.zeronative.runtime.ZnActivity
import dev.zeronative.runtime.ZnNav
import dev.zeronative.runtime.ZnNavHost
import dev.zeronative.runtime.ZnTemplates

/** A thin host: the screens, the back stack and back handling all come from the zn runtime (ZnNavHost / ZnNav). */
class MainActivity : ComponentActivity() {
    /** Back on the last screen: the same as the system's own back there. */
    private val exit: () -> Unit = { moveTaskToBack(true) }

    override fun onCreate(savedInstanceState: Bundle?) {
        // Draw behind the status and navigation bars; each route decides which edges stay clear.
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        if (ZnNav.handleExtraActivity(this, savedInstanceState)) {
            finish()
            return
        }
        ZnActivity.attach(this)
        ZnNav.onExit = exit

        // A recreated Activity has the same intent: its link was already handled.
        val link = if (savedInstanceState == null) intent?.data else null
        // savedInstanceState: after Android killed the app in the background, the screens that were open come back.
        ZnTemplates.whenReady(ASSET) { bundle -> ZnNav.start(bundle, link, savedInstanceState) }

        setContent {
            val bundle = ZnTemplates.get(ASSET)
            Box(Modifier.fillMaxSize().background(Color(0xFFF8FAFC))) {
                if (bundle != null) ZnNavHost(bundle, Modifier.fillMaxSize())
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        ZnNav.saveState(outState) // the open screens, for when Android brings the app back after killing it
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val link = intent.data ?: return
        ZnTemplates.whenReady(ASSET) { ZnNav.openLink(link) }
    }

    override fun onDestroy() {
        if (ZnNav.onExit === exit) ZnNav.onExit = null
        super.onDestroy()
    }

    private companion object {
        const val ASSET = "main.zn.ui"
    }
}
