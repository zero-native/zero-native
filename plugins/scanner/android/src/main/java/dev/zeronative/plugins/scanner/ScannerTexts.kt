package dev.zeronative.plugins.scanner

import androidx.compose.ui.graphics.Color
import org.json.JSONObject

/**
 * Words and colours of the scanner, from the route's params or the view's props. The defaults are plain and belong to no
 * brand: the app passes its own. A colour that can't be read gives the default.
 */
internal class ScannerTexts(from: JSONObject) {
    val title = from.text("title", "Scan a QR code")
    val hint = from.text("hint", "")
    val linkLabel = from.text("linkLabel", "")
    val linkUrl = ScannerRules.safeLink(from.text("linkUrl", ""))
    val close = from.text("closeLabel", "Close")
    val torchOn = from.text("torchOnLabel", "Turn flash on")
    val torchOff = from.text("torchOffLabel", "Turn flash off")
    val permissionTitle = from.text("permissionTitle", "Camera is off")
    val permissionBody = from.text("permissionBody", "Allow the camera to scan codes.")
    val blockedBody = from.text("blockedBody", "Turn on the camera for this app in Settings.")
    val allow = from.text("allowLabel", "Allow camera")
    val settings = from.text("settingsLabel", "Open settings")
    val failedTitle = from.text("failedTitle", "Camera can't start")
    val failedBody = from.text("failedBody", "Another app may be using it. Close that app and try again.")
    val retry = from.text("retryLabel", "Try again")
    /** The frame and the moving line. */
    val accent = from.color("accentColor", Color.White)
    val button = from.color("buttonColor", Color.White)
    val buttonText = from.color("buttonTextColor", Color(0xFF111111))
    val formats = ScannerRules.formatCodes(from.names("formats"))
}

private fun JSONObject.text(name: String, default: String): String = if (isNull(name)) default else optString(name, default)

private fun JSONObject.names(name: String): List<String> {
    val list = optJSONArray(name) ?: return emptyList()
    return (0 until list.length()).map { list.optString(it) }
}

private fun JSONObject.color(name: String, default: Color): Color = try {
    if (isNull(name)) default else Color(android.graphics.Color.parseColor(optString(name)))
} catch (_: IllegalArgumentException) {
    default
}
