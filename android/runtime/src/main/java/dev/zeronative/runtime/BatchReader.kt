package dev.zeronative.runtime

import java.nio.ByteBuffer
import java.nio.ByteOrder

/** One UI change from JS (ARCHITECTURE.md §8.3). Values are null, Boolean, Double or String. */
sealed class BatchOp {
    data class Patch(val instance: Int, val slot: Int, val value: Any?) : BatchOp()
    data class Mount(
        val templateId: Int, val parent: Int, val anchor: Int, val instance: Int, val index: Int,
        val values: List<Any?>,
    ) : BatchOp()
    data class Remove(val instance: Int) : BatchOp()
    data class Move(val instance: Int, val toIndex: Int) : BatchOp()
    /** Back-stack change (kinds in core/include/zn/batch.h). [params] is a JSON string or null. */
    data class Nav(val kind: Int, val entry: Int, val route: Int, val params: String?) : BatchOp() {
        companion object {
            const val PUSH = 1
            const val REMOVE = 2
            const val CLEAR = 3
            const val EXIT = 4
            const val BACK_ANSWERED = 5
        }
    }
}

/** Decodes the batch bytes written by core/src/batch.cpp (format in core/include/zn/batch.h). */
object BatchReader {
    private const val MAGIC = 0x31424E5A // "ZNB1"

    fun read(bytes: ByteArray): List<BatchOp> {
        val b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        require(b.int == MAGIC) { "not a zero-native batch" }
        val count = b.int
        val ops = ArrayList<BatchOp>(count)
        repeat(count) {
            ops += when (val code = b.get().toInt()) {
                1 -> BatchOp.Patch(b.int, b.u16(), b.value())
                2 -> {
                    val templateId = b.u16()
                    val parent = b.int
                    val anchor = b.u16()
                    val instance = b.int
                    val index = b.int
                    val n = b.u16()
                    BatchOp.Mount(templateId, parent, anchor, instance, index, List(n) { b.value() })
                }
                3 -> BatchOp.Remove(b.int)
                4 -> BatchOp.Move(b.int, b.int)
                5 -> BatchOp.Nav(b.get().toInt(), b.int, b.u16(), b.value() as String?)
                else -> error("unknown batch op $code")
            }
        }
        require(!b.hasRemaining()) { "batch has ${b.remaining()} extra bytes" }
        return ops
    }

    private fun ByteBuffer.u16(): Int = short.toInt() and 0xFFFF

    private fun ByteBuffer.value(): Any? = when (val kind = get().toInt()) {
        0 -> null
        1 -> false
        2 -> true
        3 -> double
        4 -> {
            val len = int
            val text = String(array(), arrayOffset() + position(), len, Charsets.UTF_8)
            position(position() + len)
            text
        }
        else -> error("unknown value kind $kind")
    }
}
