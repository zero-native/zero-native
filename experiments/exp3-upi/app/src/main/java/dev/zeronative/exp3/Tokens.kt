package dev.zeronative.exp3

import androidx.compose.ui.graphics.Color

object ZnColors {
    val Primary = Color(0xFF3D26ED)
    val PrimaryHover = Color(0xFF341DEC)
    val PrimaryLight = Color(0xFFEEF2FF)
    val Surface = Color(0xFFFFFFFF)
    val Background = Color(0xFFF8FAFC)
    val TextPrimary = Color(0xFF1C1C1C)
    val TextSecondary = Color(0xFF64748B)
    val TextMuted = Color(0xFF94A3B8)
    val TextDisabled = Color(0xFFBDBDBD)
    val Border = Color(0xFFE2E8F0)
    val Success = Color(0xFF10B981)
    val SuccessLight = Color(0xFFECFDF5)
    val SuccessText = Color(0xFF047857)
    val KeypadBg = Color(0xFFF8FAFC)
    val KeypadText = Color(0xFF0F172A)
    val KeypadPressed = Color(0xFFE2E8F0)

    fun parseColor(hex: String?): Color {
        if (hex.isNullOrBlank()) return Color.Unspecified
        return try {
            val clean = hex.removePrefix("#")
            when (clean.length) {
                6 -> Color(android.graphics.Color.parseColor("#$clean"))
                8 -> Color(android.graphics.Color.parseColor("#$clean"))
                else -> Color.Unspecified
            }
        } catch (_: Exception) {
            Color.Unspecified
        }
    }
}
