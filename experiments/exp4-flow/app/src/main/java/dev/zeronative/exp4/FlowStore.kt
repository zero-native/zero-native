package dev.zeronative.exp4

import android.util.Log
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel
import java.util.zip.CRC32

/**
 * Two-Slot Crash-Safe Mmap FlowStore (ARCHITECTURE §13.2)
 *
 * File structure:
 * Header: 64 bytes
 *   [0..3]:   "ZNFS"
 *   [4..7]:   formatVersion (u32, 1)
 *   [8..11]:  slotSize (u32, default 32768)
 *   [12..63]: reserved
 *
 * Slot structure (2 slots: Slot 0 at 64, Slot 1 at 64 + slotSize):
 *   [0..7]:   seq (u64, little-endian)
 *   [8..11]:  length (u32, little-endian)
 *   [12..15]: crc32 (u32, little-endian)
 *   [16..]:   payload (UTF-8 bytes)
 */
class FlowStore(
    private val file: File,
    private val slotSize: Int = DEFAULT_SLOT_SIZE
) {
    companion object {
        private const val TAG = "zn-FlowStore"
        const val HEADER_SIZE = 64
        const val SLOT_HEADER_SIZE = 16
        const val DEFAULT_SLOT_SIZE = 32768 // 32 KB

        private val MAGIC = byteArrayOf('Z'.code.toByte(), 'N'.code.toByte(), 'F'.code.toByte(), 'S'.code.toByte())

        fun getStore(filesDir: File, flowName: String): FlowStore {
            val dir = File(filesDir, "zn-flows")
            if (!dir.exists()) dir.mkdirs()
            return FlowStore(File(dir, "$flowName.znfs"))
        }
    }

    private val totalSize = HEADER_SIZE + 2 * slotSize
    private var mmapBuffer: ByteBuffer? = null

    init {
        ensureFileInitialized()
    }

    private fun ensureFileInitialized() {
        val raf = RandomAccessFile(file, "rw")
        try {
            if (raf.length() < totalSize) {
                raf.setLength(totalSize.toLong())
                raf.seek(0)
                raf.write(MAGIC)
                raf.writeInt(Integer.reverseBytes(1)) // formatVersion
                raf.writeInt(Integer.reverseBytes(slotSize)) // slotSize
            }
            val channel = raf.channel
            mmapBuffer = channel.map(FileChannel.MapMode.READ_WRITE, 0, totalSize.toLong())
            mmapBuffer?.order(ByteOrder.LITTLE_ENDIAN)
        } finally {
            raf.close()
        }
    }

    data class SlotReadResult(
        val slotIndex: Int,
        val seq: Long,
        val valid: Boolean,
        val payload: String?
    )

    private fun readSlot(slotIndex: Int): SlotReadResult {
        val buf = mmapBuffer ?: return SlotReadResult(slotIndex, 0, false, null)
        val offset = HEADER_SIZE + slotIndex * slotSize

        val seq = buf.getLong(offset)
        val length = buf.getInt(offset + 8)
        val storedCrc = buf.getInt(offset + 12).toLong() and 0xFFFFFFFFL

        val maxPayload = slotSize - SLOT_HEADER_SIZE
        if (seq <= 0L || length <= 0 || length > maxPayload) {
            return SlotReadResult(slotIndex, seq, false, null)
        }

        val payloadBytes = ByteArray(length)
        val originalPos = buf.position()
        buf.position(offset + 16)
        buf.get(payloadBytes)
        buf.position(originalPos)

        val crcCalculator = CRC32()
        crcCalculator.update(payloadBytes)
        val computedCrc = crcCalculator.value

        if (computedCrc != storedCrc) {
            Log.w(TAG, "CRC32 mismatch on slot $slotIndex: stored=$storedCrc, computed=$computedCrc")
            return SlotReadResult(slotIndex, seq, false, null)
        }

        val payloadStr = String(payloadBytes, Charsets.UTF_8)
        return SlotReadResult(slotIndex, seq, true, payloadStr)
    }

    @Synchronized
    fun read(): String? {
        val slot0 = readSlot(0)
        val slot1 = readSlot(1)

        if (!slot0.valid && !slot1.valid) {
            return null
        }

        if (slot0.valid && !slot1.valid) {
            return slot0.payload
        }
        if (!slot0.valid && slot1.valid) {
            return slot1.payload
        }

        // Both valid: choose highest seq
        return if (slot0.seq >= slot1.seq) slot0.payload else slot1.payload
    }

    @Synchronized
    fun write(payloadJson: String): Long {
        val buf = mmapBuffer ?: throw IllegalStateException("FlowStore not mapped")
        val slot0 = readSlot(0)
        val slot1 = readSlot(1)

        // Find active slot and next seq
        val activeSlot = when {
            slot0.valid && !slot1.valid -> 0
            !slot0.valid && slot1.valid -> 1
            slot0.valid && slot1.valid -> if (slot0.seq >= slot1.seq) 0 else 1
            else -> -1
        }

        val currentSeq = when (activeSlot) {
            0 -> slot0.seq
            1 -> slot1.seq
            else -> 0L
        }

        val nextSlot = if (activeSlot == 0) 1 else 0
        val nextSeq = currentSeq + 1L

        val payloadBytes = payloadJson.toByteArray(Charsets.UTF_8)
        val maxPayload = slotSize - SLOT_HEADER_SIZE
        if (payloadBytes.size > maxPayload) {
            throw IllegalArgumentException("Payload size ${payloadBytes.size} exceeds slot max $maxPayload")
        }

        val targetOffset = HEADER_SIZE + nextSlot * slotSize

        // 1. Write payload into inactive slot
        val originalPos = buf.position()
        buf.position(targetOffset + 16)
        buf.put(payloadBytes)

        // 2. Write length
        buf.putInt(targetOffset + 8, payloadBytes.size)

        // 3. Compute and write CRC32
        val crcCalculator = CRC32()
        crcCalculator.update(payloadBytes)
        buf.putInt(targetOffset + 12, crcCalculator.value.toInt())

        // 4. Release barrier: write seq last
        buf.putLong(targetOffset, nextSeq)
        buf.position(originalPos)

        return nextSeq
    }

    @Synchronized
    fun delete() {
        try {
            mmapBuffer = null
            if (file.exists()) {
                file.delete()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error deleting store file", e)
        }
    }
}
