package dev.zeronative.runtime

import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * Builds batches byte by byte following core/include/zn/batch.h and checks the reader.
 * (The C++ writer is tested on the phone by tools/run-core-tests.ps1 against the same layout.)
 */
class BatchReaderTest {
    private class Writer {
        private val b = ByteBuffer.allocate(1024).order(ByteOrder.LITTLE_ENDIAN)
        fun u8(v: Int) = apply { b.put(v.toByte()) }
        fun u16(v: Int) = apply { b.putShort(v.toShort()) }
        fun u32(v: Int) = apply { b.putInt(v) }
        fun num(v: Double) = apply { u8(3); b.putDouble(v) }
        fun str(s: String) = apply {
            val bytes = s.toByteArray(Charsets.UTF_8)
            u8(4); u32(bytes.size); b.put(bytes)
        }
        fun bytes(): ByteArray = b.array().copyOf(b.position())
    }

    private fun header(count: Int) = Writer().u32(0x31424E5A).u32(count)

    @Test
    fun readsNavOps() {
        val bytes = header(3)
            .u8(5).u8(1).u32(12).u16(1).str("{\"merchantId\":\"m1\"}")     // NAV PUSH with params
            .u8(5).u8(2).u32(12).u16(0).u8(0)                                // NAV REMOVE, no params
            .u8(5).u8(5).u32(0).u16(0).u8(0)                                 // NAV BACK_ANSWERED
            .bytes()
        assertEquals(
            listOf(
                BatchOp.Nav(BatchOp.Nav.PUSH, 12, 1, "{\"merchantId\":\"m1\"}"),
                BatchOp.Nav(BatchOp.Nav.REMOVE, 12, 0, null),
                BatchOp.Nav(BatchOp.Nav.BACK_ANSWERED, 0, 0, null),
            ),
            BatchReader.read(bytes),
        )
    }

    @Test
    fun readsListOps() {
        val bytes = header(3)
            .u8(6).u32(7).u16(3).u32(2).str("a").u16(4).str("b").u16(5)          // LIST_SET
            .u8(7).u32(7).u16(3).u32(0).u32(1).u32(1).str("c").u16(4)           // LIST_SPLICE
            .u8(8).u32(7).u16(3).str("c").u32(12)                               // LIST_ROW
            .bytes()
        assertEquals(
            listOf(
                BatchOp.ListSet(7, 3, listOf("a", "b"), listOf(4, 5)),
                BatchOp.ListSplice(7, 3, 0, 1, listOf("c"), listOf(4)),
                BatchOp.ListRow(7, 3, "c", 12),
            ),
            BatchReader.read(bytes),
        )
    }

    @Test
    fun readsAllOpKinds() {
        val bytes = header(4)
            .u8(1).u32(7).u16(2).num(42.0)                                  // PATCH
            .u8(2).u16(5).u32(1).u16(0).u32(9).u32(0).u16(3)                // MOUNT with 3 values
            .u8(0).u8(2).str("₹1,250")
            .u8(3).u32(9)                                                    // REMOVE
            .u8(4).u32(8).u32(2)                                             // MOVE
            .bytes()

        val ops = BatchReader.read(bytes)
        assertEquals(
            listOf(
                BatchOp.Patch(7, 2, 42.0),
                BatchOp.Mount(5, 1, 0, 9, 0, listOf(null, true, "₹1,250")),
                BatchOp.Remove(9),
                BatchOp.Move(8, 2),
            ),
            ops,
        )
    }

    @Test
    fun readsHighSlotAndTemplateIdsAsUnsigned() {
        val bytes = header(1).u8(1).u32(1).u16(0xFFFF).u8(1).bytes()
        assertEquals(listOf(BatchOp.Patch(1, 65535, false)), BatchReader.read(bytes))
    }

    @Test
    fun rejectsWrongMagic() {
        val bytes = Writer().u32(0x12345678).u32(0).bytes()
        assertThrows(IllegalArgumentException::class.java) { BatchReader.read(bytes) }
    }

    @Test
    fun rejectsTrailingBytes() {
        val bytes = header(0).u8(1).bytes()
        assertThrows(IllegalArgumentException::class.java) { BatchReader.read(bytes) }
    }
}
