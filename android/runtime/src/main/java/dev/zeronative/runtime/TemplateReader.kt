package dev.zeronative.runtime

import java.nio.ByteBuffer
import java.nio.ByteOrder

/** A colour from a template, already parsed at build time (ARGB). */
@JvmInline value class ZnColor(val argb: Int)

/** A size given as a fraction of the parent ("50%" → 0.5). */
@JvmInline value class ZnPercent(val fraction: Double)

/** A registry enum value (see Registry.kt). */
@JvmInline value class ZnEnum(val value: Int)

class SlotDef(val node: Int, val prop: Int, val default: Any?)

class EventDef(val node: Int, val kind: Int, val eventId: Int)

/** One template as read from the file: plain data, before preparation for drawing. */
class RawTemplate(
    val component: IntArray,
    val parent: IntArray,
    /** Static props per node: propId → value (null, Boolean, Double, String, ZnColor, ZnPercent, ZnEnum). */
    val props: Array<Map<Int, Any?>>,
    val slots: List<SlotDef>,
    val events: List<EventDef>,
)

class TemplateFile(val registryVersion: Int, val templates: List<RawTemplate>)

/**
 * Reads .zn.ui files (format: packages/template/src/writer.ts). Called once per file; the result is prepared once
 * per template (ZnTemplate) and never parsed again.
 */
object TemplateReader {
    private const val MAGIC = 0x49554E5A // "ZNUI"
    private const val FORMAT_VERSION = 1
    private const val ROOT_PARENT = 0xFFFF

    // Ids this app knows (Registry.kt). Every id in a file is checked against them, so templates from an OTA bundle
    // that use something this app doesn't have are refused when read, never drawn wrongly (docs/ota.md §3.2).
    private val knownComponents = idSet(Registry.COMPONENT_IDS)
    private val knownProps = idSet(Registry.PROP_IDS)
    private val knownDynamicProps = idSet(Registry.DYNAMIC_PROP_IDS)
    private val knownEvents = idSet(Registry.EVENT_IDS)

    private fun idSet(ids: IntArray) = BooleanArray((ids.maxOrNull() ?: 0) + 1).also { for (id in ids) it[id] = true }

    private fun BooleanArray.has(id: Int) = id in indices && this[id]

    private fun checkProp(where: String, prop: Int, value: Any?) {
        require(knownProps.has(prop)) { "$where: unknown prop $prop (this app has registry v${Registry.VERSION})" }
        if (value is ZnEnum) {
            val known = Registry.ENUM_VALUES[prop]
            require(known != null && value.value in known) { "$where: prop $prop has unknown value ${value.value}" }
        }
    }

    fun read(buffer: ByteBuffer): TemplateFile {
        val b = buffer.duplicate().order(ByteOrder.LITTLE_ENDIAN)
        require(b.int == MAGIC) { "not a .zn.ui template file" }
        val format = b.u16()
        require(format == FORMAT_VERSION) { "template format $format is not supported (this runtime reads $FORMAT_VERSION)" }
        val registry = b.u16()
        require(registry <= Registry.VERSION) {
            "template needs registry v$registry, this app has v${Registry.VERSION} (capability check, ARCHITECTURE §16.2)"
        }

        val strings = Array(b.int) {
            val bytes = ByteArray(b.int)
            b.get(bytes)
            String(bytes, Charsets.UTF_8)
        }

        val templates = List(b.u16()) {
            val nodeCount = b.u16()
            val component = IntArray(nodeCount)
            val parent = IntArray(nodeCount)
            val props = Array<Map<Int, Any?>>(nodeCount) { n ->
                component[n] = b.u16()
                require(knownComponents.has(component[n])) {
                    "node $n: unknown component ${component[n]} (this app has registry v${Registry.VERSION})"
                }
                val p = b.u16()
                parent[n] = if (p == ROOT_PARENT) -1 else p
                require(n == 0 || parent[n] in 0 until n) { "node $n: parent must come before its children" }
                val count = b.get().toInt() and 0xFF
                HashMap<Int, Any?>(count * 2).apply {
                    repeat(count) {
                        val prop = b.u16()
                        val value = b.value(strings)
                        checkProp("node $n", prop, value)
                        put(prop, value)
                    }
                }
            }
            val slots = List(b.u16()) {
                SlotDef(b.u16(), b.u16(), b.value(strings)).also { s ->
                    checkProp("slot on node ${s.node}", s.prop, s.default)
                    require(knownDynamicProps.has(s.prop)) { "slot on node ${s.node}: prop ${s.prop} can't change at runtime in this app" }
                }
            }
            val events = List(b.u16()) {
                EventDef(b.u16(), b.u16(), b.u16()).also { e ->
                    require(knownEvents.has(e.kind)) { "node ${e.node}: unknown event ${e.kind} (this app has registry v${Registry.VERSION})" }
                }
            }
            RawTemplate(component, parent, props, slots, events)
        }
        require(!b.hasRemaining()) { "template file has ${b.remaining()} extra bytes" }
        return TemplateFile(registry, templates)
    }

    private fun ByteBuffer.u16(): Int = short.toInt() and 0xFFFF

    private fun ByteBuffer.value(strings: Array<String>): Any? = when (val kind = get().toInt()) {
        0 -> null
        1 -> false
        2 -> true
        3 -> double
        4 -> strings[int]
        5 -> ZnColor(int)
        6 -> ZnPercent(double)
        7 -> ZnEnum(u16())
        else -> error("unknown template value kind $kind")
    }
}
