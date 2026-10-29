// The batch: UI changes JS sends to native once per tick (ARCHITECTURE.md §8.3).
//
// Byte format (little-endian), read by android/runtime/.../BatchReader.kt:
//   batch   = u32 magic "ZNB1" | u32 opCount | op*
//   PATCH   = u8 1 | u32 instance | u16 slot | value
//   MOUNT   = u8 2 | u16 template | u32 parent | u16 anchor | u32 instance | u32 index | u16 count | value*
//   REMOVE  = u8 3 | u32 instance
//   MOVE    = u8 4 | u32 instance | u32 toIndex
//   NAV     = u8 5 | u8 kind | u32 entry | u16 route | value (params: JSON string, or null)
//   value   = u8 kind (0 null, 1 false, 2 true, 3 number, 4 string) | f64 (number) | u32 length + UTF-8 (string)
//
// NAV kinds (the back stack is owned by JS, ARCHITECTURE §11; native applies a whole batch at once, so it only ever
// sees the resulting stack and picks the transition from it):
//   1 PUSH   add `entry` on top: native creates its root instance from the route's template (entry id = root id)
//   2 REMOVE take `entry` out of the stack; its instances stay alive until its exit animation ends
//   3 CLEAR  take every entry out (a reset is CLEAR + PUSH... in one batch; a replace is REMOVE + PUSH)
//   4 EXIT   the stack's last screen was backed out of: let the system handle back (leave the app)
//   5 BACK_ANSWERED  JS has handled the last system back press (stops native's 300 ms fallback)
// A NAV op is structural: it keeps its place in the batch and is never merged.
#pragma once

#include <cstdint>
#include <unordered_map>
#include <vector>

#include "zn/value.h"

namespace zn {

enum class OpCode : uint8_t { Patch = 1, Mount = 2, Remove = 3, Move = 4, Nav = 5 };
enum class NavKind : uint8_t { Push = 1, Remove = 2, Clear = 3, Exit = 4, BackAnswered = 5 };

constexpr uint32_t kBatchMagic = 0x31424E5A;  // "ZNB1" read as little-endian bytes

struct Op {
  OpCode code = OpCode::Patch;
  uint32_t instance = 0;     // NAV: the entry id
  uint16_t slot = 0;         // PATCH
  Value value;               // PATCH; NAV: params
  NavKind navKind = NavKind::Push;  // NAV
  uint16_t route = 0;        // NAV: route index in the bundle manifest
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
  void nav(NavKind kind, uint32_t entry, uint16_t route, Value params);

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
