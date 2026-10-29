// The batch: UI changes JS sends to native once per tick (ARCHITECTURE.md §8.3).
//
// Byte format (little-endian), read by android/runtime/.../BatchReader.kt:
//   batch   = u32 magic "ZNB1" | u32 opCount | op*
//   PATCH   = u8 1 | u32 instance | u16 slot | value
//   MOUNT   = u8 2 | u16 template | u32 parent | u16 anchor | u32 instance | u32 index | u16 count | value*
//   REMOVE  = u8 3 | u32 instance
//   MOVE    = u8 4 | u32 instance | u32 toIndex
//   value   = u8 kind (0 null, 1 false, 2 true, 3 number, 4 string) | f64 (number) | u32 length + UTF-8 (string)
#pragma once

#include <cstdint>
#include <unordered_map>
#include <vector>

#include "zn/value.h"

namespace zn {

enum class OpCode : uint8_t { Patch = 1, Mount = 2, Remove = 3, Move = 4 };

constexpr uint32_t kBatchMagic = 0x31424E5A;  // "ZNB1" read as little-endian bytes

struct Op {
  OpCode code = OpCode::Patch;
  uint32_t instance = 0;
  uint16_t slot = 0;         // PATCH
  Value value;               // PATCH
  uint16_t templateId = 0;   // MOUNT
  uint32_t parent = 0;       // MOUNT
  uint16_t anchor = 0;       // MOUNT
  uint32_t index = 0;        // MOUNT: position among siblings; MOVE: new position
  std::vector<Value> values; // MOUNT: initial slot values
};

class Batch {
 public:
  // A later patch to the same (instance, slot) replaces the earlier one; structural ops keep their order.
  void patch(uint32_t instance, uint16_t slot, Value value);
  void mount(uint16_t templateId, uint32_t parent, uint16_t anchor, uint32_t instance, uint32_t index,
             std::vector<Value> values);
  void remove(uint32_t instance);
  void move(uint32_t instance, uint32_t toIndex);

  // Appends all ops of `other` in order, with the same patch-replacing rule (used to coalesce ticks).
  void append(const Batch& other);

  bool empty() const { return ops_.empty(); }
  size_t size() const { return ops_.size(); }
  const std::vector<Op>& ops() const { return ops_; }
  void clear();

  std::vector<uint8_t> encode() const;

 private:
  void push(Op op);

  std::vector<Op> ops_;
  std::unordered_map<uint64_t, size_t> patchIndex_;  // (instance << 16 | slot) → index in ops_
};

}  // namespace zn
