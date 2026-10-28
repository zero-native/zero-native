import { crc32 } from './crc32';
import * as fs from 'fs';

/**
 * Two-Slot Crash-Safe Mmap FlowStore File Format (ARCHITECTURE §13.2)
 *
 * Header: 64 bytes
 *   [0..3]:   "ZNFS" (magic)
 *   [4..7]:   formatVersion (u32)
 *   [8..11]:  slotSize (u32, default 32768)
 *   [12..63]: reserved
 *
 * Slot structure (size = slotSize):
 *   [0..7]:   seq (u64, little-endian)
 *   [8..11]:  length (u32, little-endian)
 *   [12..15]: crc32 (u32, little-endian)
 *   [16..]:   payload (UTF-8 bytes)
 */

export const HEADER_SIZE = 64;
export const SLOT_HEADER_SIZE = 16;
export const DEFAULT_SLOT_SIZE = 32768; // 32 KB

export interface SlotInfo {
  slotIndex: 0 | 1;
  offset: number;
  seq: bigint;
  length: number;
  crc: number;
  valid: boolean;
  payloadStr?: string;
}

export class FlowStoreFile {
  private filePath: string;
  private slotSize: number;
  private buffer: Buffer;

  constructor(filePath: string, slotSize = DEFAULT_SLOT_SIZE) {
    this.filePath = filePath;
    this.slotSize = slotSize;
    const totalSize = HEADER_SIZE + 2 * slotSize;

    if (fs.existsSync(filePath)) {
      this.buffer = fs.readFileSync(filePath);
      if (this.buffer.length < totalSize) {
        // Expand to required size
        const newBuf = Buffer.alloc(totalSize);
        this.buffer.copy(newBuf);
        this.buffer = newBuf;
      }
    } else {
      this.buffer = Buffer.alloc(totalSize);
      // Write Magic "ZNFS"
      this.buffer.write('ZNFS', 0, 4, 'ascii');
      this.buffer.writeUInt32LE(1, 4); // formatVersion
      this.buffer.writeUInt32LE(slotSize, 8); // slotSize
      fs.writeFileSync(filePath, this.buffer);
    }
  }

  private getSlotOffset(slotIndex: 0 | 1): number {
    return HEADER_SIZE + slotIndex * this.slotSize;
  }

  public readSlot(slotIndex: 0 | 1): SlotInfo {
    const offset = this.getSlotOffset(slotIndex);
    const seq = this.buffer.readBigUInt64LE(offset);
    const length = this.buffer.readUInt32LE(offset + 8);
    const storedCrc = this.buffer.readUInt32LE(offset + 12);

    const maxPayload = this.slotSize - SLOT_HEADER_SIZE;
    if (seq === 0n || length > maxPayload) {
      return { slotIndex, offset, seq, length, crc: storedCrc, valid: false };
    }

    const payloadBuffer = this.buffer.subarray(offset + 16, offset + 16 + length);
    const computedCrc = crc32(payloadBuffer);

    if (computedCrc !== storedCrc) {
      return { slotIndex, offset, seq, length, crc: storedCrc, valid: false };
    }

    const payloadStr = payloadBuffer.toString('utf-8');
    return {
      slotIndex,
      offset,
      seq,
      length,
      crc: storedCrc,
      valid: true,
      payloadStr,
    };
  }

  /**
   * Reads current valid flow state (slot with highest seq).
   */
  public read(): { payloadStr: string; seq: bigint; activeSlot: 0 | 1 } | null {
    const slot0 = this.readSlot(0);
    const slot1 = this.readSlot(1);

    if (!slot0.valid && !slot1.valid) {
      return null;
    }

    if (slot0.valid && !slot1.valid) {
      return { payloadStr: slot0.payloadStr!, seq: slot0.seq, activeSlot: 0 };
    }

    if (!slot0.valid && slot1.valid) {
      return { payloadStr: slot1.payloadStr!, seq: slot1.seq, activeSlot: 1 };
    }

    // Both valid: pick higher sequence
    if (slot0.seq >= slot1.seq) {
      return { payloadStr: slot0.payloadStr!, seq: slot0.seq, activeSlot: 0 };
    } else {
      return { payloadStr: slot1.payloadStr!, seq: slot1.seq, activeSlot: 1 };
    }
  }

  /**
   * Writes payload to inactive slot with atomic sequence update.
   */
  public write(payloadStr: string): bigint {
    const current = this.read();
    const targetSlotIndex: 0 | 1 = current ? (current.activeSlot === 0 ? 1 : 0) : 0;
    const nextSeq = current ? current.seq + 1n : 1n;

    const payloadBytes = Buffer.from(payloadStr, 'utf-8');
    const maxPayload = this.slotSize - SLOT_HEADER_SIZE;
    if (payloadBytes.length > maxPayload) {
      throw new Error(`Payload exceeds slot capacity (${payloadBytes.length} > ${maxPayload})`);
    }

    const targetOffset = this.getSlotOffset(targetSlotIndex);

    // 1. Write payload into inactive slot
    payloadBytes.copy(this.buffer, targetOffset + 16);

    // 2. Write length
    this.buffer.writeUInt32LE(payloadBytes.length, targetOffset + 8);

    // 3. Write CRC32 of payload
    const computedCrc = crc32(new Uint8Array(this.buffer.subarray(targetOffset + 16, targetOffset + 16 + payloadBytes.length)));
    this.buffer.writeUInt32LE(computedCrc, targetOffset + 12);

    // 4. Atomic release barrier: write new seq last
    this.buffer.writeBigUInt64LE(nextSeq, targetOffset);

    // Flush to disk
    fs.writeFileSync(this.filePath, this.buffer);
    return nextSeq;
  }

  /**
   * For testing: corrupts active slot to simulate torn write / crash mid-write.
   */
  public corruptActiveSlot(): void {
    const current = this.read();
    if (!current) return;
    const offset = this.getSlotOffset(current.activeSlot);
    // Invert a byte in payload
    this.buffer[offset + 20] = this.buffer[offset + 20] ^ 0xff;
    fs.writeFileSync(this.filePath, this.buffer);
  }
}
