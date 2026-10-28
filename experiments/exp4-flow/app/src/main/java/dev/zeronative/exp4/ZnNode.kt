package dev.zeronative.exp4

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf

class ZnNode(val id: Int, val type: String) {
    private val props = HashMap<String, MutableState<Any?>>()
    val children = mutableStateListOf<Int>()
    val animatables = HashMap<String, Animatable<Float, AnimationVector1D>>()

    // Recomposition counter for auditing Milestone 4
    var debugRecomposeCount = 0

    fun prop(key: String): MutableState<Any?> {
        return props.getOrPut(key) { mutableStateOf(null) }
    }

    fun hasProp(key: String): Boolean = props.containsKey(key)
    fun hasEvent(key: String): Boolean = (props[key]?.value as? Boolean) == true

    fun getString(key: String, default: String = ""): String {
        return (props[key]?.value as? String) ?: default
    }

    fun getInt(key: String, default: Int = 0): Int {
        val v = props[key]?.value ?: return default
        return when (v) {
            is Number -> v.toInt()
            is String -> v.toIntOrNull() ?: default
            else -> default
        }
    }

    fun getFloat(key: String, default: Float = 0f): Float {
        val v = props[key]?.value ?: return default
        return when (v) {
            is Number -> v.toFloat()
            is String -> v.toFloatOrNull() ?: default
            else -> default
        }
    }

    fun getBoolean(key: String, default: Boolean = false): Boolean {
        val v = props[key]?.value ?: return default
        return when (v) {
            is Boolean -> v
            is String -> v.toBoolean()
            else -> default
        }
    }
}

