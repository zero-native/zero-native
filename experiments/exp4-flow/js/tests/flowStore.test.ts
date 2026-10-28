import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { FlowStoreFile, DEFAULT_SLOT_SIZE, HEADER_SIZE } from '../zn/flowStore';
import * as fs from 'fs';
import * as path from 'path';

describe('Two-Slot Crash-Safe FlowStore (ARCHITECTURE §13.2)', () => {
  const testDir = path.join(__dirname, 'temp_flow_store');
  const testFile = path.join(testDir, 'test_flow.znfs');

  beforeEach(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
  });

  afterEach(() => {
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
    if (fs.existsSync(testDir)) {
      fs.rmdirSync(testDir);
    }
  });

  it('initializes file with 64-byte ZNFS header', () => {
    const store = new FlowStoreFile(testFile, 1024);
    const buf = fs.readFileSync(testFile);
    expect(buf.toString('ascii', 0, 4)).toBe('ZNFS');
    expect(buf.readUInt32LE(4)).toBe(1); // formatVersion
    expect(buf.readUInt32LE(8)).toBe(1024); // slotSize
    expect(buf.length).toBe(64 + 2 * 1024);
  });

  it('alternates between Slot A and Slot B on consecutive writes', () => {
    const store = new FlowStoreFile(testFile, 1024);

    // Write 1 -> Slot A
    const seq1 = store.write(JSON.stringify({ step: 'entering', amount: 100 }));
    expect(seq1).toBe(1n);

    const read1 = store.read()!;
    expect(read1.activeSlot).toBe(0);
    expect(JSON.parse(read1.payloadStr).step).toBe('entering');

    // Write 2 -> Slot B
    const seq2 = store.write(JSON.stringify({ step: 'paying', amount: 100 }));
    expect(seq2).toBe(2n);

    const read2 = store.read()!;
    expect(read2.activeSlot).toBe(1);
    expect(JSON.parse(read2.payloadStr).step).toBe('paying');

    // Write 3 -> Slot A again
    const seq3 = store.write(JSON.stringify({ step: 'verifying', amount: 100 }));
    expect(seq3).toBe(3n);

    const read3 = store.read()!;
    expect(read3.activeSlot).toBe(0);
    expect(JSON.parse(read3.payloadStr).step).toBe('verifying');
  });

  it('TORN WRITE RECOVERY: restores previous good state if active slot is corrupted', () => {
    const store = new FlowStoreFile(testFile, 1024);

    // State 1: good state in Slot A
    store.write(JSON.stringify({ step: 'entering', val: 'good_state_1' }));

    // State 2: good state in Slot B
    store.write(JSON.stringify({ step: 'paying', val: 'good_state_2' }));

    expect(store.read()!.activeSlot).toBe(1);
    expect(JSON.parse(store.read()!.payloadStr).val).toBe('good_state_2');

    // Corrupt active Slot B (simulating crash during disk write / torn slot)
    store.corruptActiveSlot();

    // Reader must detect CRC32 mismatch on Slot B and seamlessly fall back to Slot A!
    const recovered = store.read();
    expect(recovered).not.toBeNull();
    expect(recovered!.activeSlot).toBe(0); // Fell back to Slot A!
    expect(JSON.parse(recovered!.payloadStr).val).toBe('good_state_1');
  });

  it('re-attaches FlowStore to FlowInstance adapter seamlessly', () => {
    const store = new FlowStoreFile(testFile, 1024);
    store.write(JSON.stringify({ flowId: 'f1', step: 'verifying' }));

    // Reopen store from disk (like app cold start)
    const newStoreInstance = new FlowStoreFile(testFile, 1024);
    const restored = newStoreInstance.read();
    expect(restored).not.toBeNull();
    expect(JSON.parse(restored!.payloadStr).step).toBe('verifying');
  });
});
