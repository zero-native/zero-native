package dev.zeronative.runtime

import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

/** Builds .zn.ui bytes by hand following packages/template/src/writer.ts and checks the reader. */
class TemplateReaderTest {
    private class W {
        private val b = ByteBuffer.allocate(1024).order(ByteOrder.LITTLE_ENDIAN)
        fun u8(v: Int) = apply { b.put(v.toByte()) }
        fun u16(v: Int) = apply { b.putShort(v.toShort()) }
        fun u32(v: Int) = apply { b.putInt(v) }
        fun f64(v: Double) = apply { b.putDouble(v) }
        fun str(s: String) = apply { val x = s.toByteArray(); u32(x.size); b.put(x) }
        fun buffer(): ByteBuffer = ByteBuffer.wrap(b.array().copyOf(b.position()))
    }

    private fun header(strings: List<String>) =
        W().u32(0x49554E5A).u16(1).u16(1).u32(strings.size).apply { strings.forEach { str(it) } }

    @Test
    fun readsNodesPropsSlotsAndEvents() {
        val bytes = header(listOf("…", "Tap"))
            .u16(1) // one template
            .u16(3) // nodes
            .u16(Registry.Component.COLUMN).u16(0xFFFF).u8(2)
            .u16(Registry.Prop.PADDING).u8(3).f64(24.0)
            .u16(Registry.Prop.BACKGROUND_COLOR).u8(5).u32(0xFFF8FAFC.toInt())
            .u16(Registry.Component.TEXT).u16(0).u8(0)
            .u16(Registry.Component.PRESSABLE).u16(0).u8(2)
            .u16(Registry.Prop.WIDTH).u8(6).f64(1.0)
            .u16(Registry.Prop.ALIGN_ITEMS).u8(7).u16(Registry.AlignItems.CENTER)
            .u16(1).u16(1).u16(Registry.Prop.TEXT).u8(4).u32(0) // slot 0: node 1 text, default "…"
            .u16(1).u16(2).u16(Registry.Event.ON_PRESS).u16(1)   // event: node 2 onPress → id 1
            .buffer()

        val t = TemplateReader.read(bytes).templates.single()
        assertEquals(listOf(Registry.Component.COLUMN, Registry.Component.TEXT, Registry.Component.PRESSABLE), t.component.toList())
        assertEquals(listOf(-1, 0, 0), t.parent.toList())
        assertEquals(24.0, t.props[0][Registry.Prop.PADDING])
        assertEquals(ZnColor(0xFFF8FAFC.toInt()), t.props[0][Registry.Prop.BACKGROUND_COLOR])
        assertEquals(ZnPercent(1.0), t.props[2][Registry.Prop.WIDTH])
        assertEquals(ZnEnum(Registry.AlignItems.CENTER), t.props[2][Registry.Prop.ALIGN_ITEMS])
        assertNull(t.props[1][Registry.Prop.TEXT])
        assertEquals("…", t.slots.single().default)
        assertEquals(Registry.Event.ON_PRESS, t.events.single().kind)
    }

    @Test
    fun rejectsNewerRegistry() {
        val bytes = W().u32(0x49554E5A).u16(1).u16(Registry.VERSION + 1).u32(0).u16(0).buffer()
        assertThrows(IllegalArgumentException::class.java) { TemplateReader.read(bytes) }
    }

    @Test
    fun rejectsChildBeforeParent() {
        val bytes = header(emptyList()).u16(1).u16(2)
            .u16(Registry.Component.COLUMN).u16(0xFFFF).u8(0)
            .u16(Registry.Component.TEXT).u16(5).u8(0)
            .u16(0).u16(0).buffer()
        assertThrows(IllegalArgumentException::class.java) { TemplateReader.read(bytes) }
    }

    // ---- Ids this app doesn't know (an OTA bundle built for a newer app, docs/ota.md §3.2) -------------------------

    private fun oneNode(component: Int, props: W.() -> W = { this }, count: Int = 0) =
        header(emptyList()).u16(1).u16(1).u16(component).u16(0xFFFF).u8(count).props()

    private fun refused(bytes: ByteBuffer, part: String) {
        val e = assertThrows(IllegalArgumentException::class.java) { TemplateReader.read(bytes) }
        org.junit.Assert.assertTrue("\"${e.message}\" should mention \"$part\"", e.message!!.contains(part))
    }

    @Test
    fun refusesUnknownComponentPropEnumValueSlotAndEvent() {
        refused(oneNode(999).u16(0).u16(0).buffer(), "unknown component 999")
        refused(oneNode(Registry.Component.BOX, { u16(999).u8(3).f64(1.0) }, count = 1).u16(0).u16(0).buffer(), "unknown prop 999")
        refused(
            oneNode(Registry.Component.BOX, { u16(Registry.Prop.ALIGN_ITEMS).u8(7).u16(99) }, count = 1).u16(0).u16(0).buffer(),
            "unknown value 99",
        )
        // A slot on a prop that can't change at runtime in this app (fontSize is build-time only).
        refused(oneNode(Registry.Component.TEXT).u16(1).u16(0).u16(Registry.Prop.FONT_SIZE).u8(3).f64(14.0).u16(0).buffer(), "can't change at runtime")
        refused(oneNode(Registry.Component.PRESSABLE).u16(0).u16(1).u16(0).u16(999).u16(1).buffer(), "unknown event 999")
    }
}

