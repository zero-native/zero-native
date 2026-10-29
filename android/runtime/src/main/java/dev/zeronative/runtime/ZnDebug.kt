package dev.zeronative.runtime

/**
 * Debug helpers. Off by default; apps turn them on in debug builds only.
 *
 * Recomposition counter: when [countRecompositions] is on, every template node that recomposes is counted, keyed
 * "<Component>#<instance>.<node>". Use it to check that an update recomposes only what it should
 * (ARCHITECTURE §9.1: a slot change recomposes only the leaf that shows it). Main thread only.
 */
object ZnDebug {
    @Volatile var countRecompositions = false

    private val counts = LinkedHashMap<String, Int>()

    internal fun hit(key: String) {
        counts[key] = (counts[key] ?: 0) + 1
    }

    /** Returns the counts since the last call and resets them. */
    fun drain(): Map<String, Int> {
        val out = LinkedHashMap(counts)
        counts.clear()
        return out
    }

    internal fun componentName(type: Int): String = when (type) {
        Registry.Component.COLUMN -> "Column"
        Registry.Component.ROW -> "Row"
        Registry.Component.STACK -> "Stack"
        Registry.Component.BOX -> "Box"
        Registry.Component.TEXT -> "Text"
        Registry.Component.IMAGE -> "Image"
        Registry.Component.PRESSABLE -> "Pressable"
        Registry.Component.SPACER -> "Spacer"
        Registry.Component.ICON -> "Icon"
        Registry.Component.ANCHOR -> "Anchor"
        else -> "Node$type"
    }
}
