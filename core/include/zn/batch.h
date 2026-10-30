// The batch: UI changes JS sends to native once per tick (ARCHITECTURE.md §8.3).
//
// Byte format (little-endian), read by android/runtime/.../BatchReader.kt:
//   batch   = u32 magic "ZNB1" | u32 opCount | op*
//   PATCH   = u8 1 | u32 instance | u16 slot | value
//   MOUNT   = u8 2 | u16 template | u32 parent | u16 anchor | u32 instance | u32 index | u16 count | value*
//   REMOVE  = u8 3 | u32 instance
//   MOVE    = u8 4 | u32 instance | u32 toIndex
//   NAV     = u8 5 | u8 kind | u32 entry | u16 route | value (params: JSON string, or null)
//   LIST_SET    = u8 6 | u32 instance | u16 node | u32 count | (value key | u16 type)*
//   LIST_SPLICE = u8 7 | u32 instance | u16 node | u32 index | u32 removeCount | u32 insertCount | (value key | u16 type)*
//   LIST_ROW    = u8 8 | u32 instance | u16 node | value key | u32 rowInstance
//   value   = u8 kind (0 null, 1 false, 2 true, 3 number, 4 string) | f64 (number) | u32 length + UTF-8 (string)
//
// NAV kinds (the back stack is owned by JS, ARCHITECTURE §11; native applies a whole batch at once, so it only ever
// sees the resulting stack and picks the transition from it):
//   1 PUSH   add `entry` on top: native creates its root instance from the route's template (entry id = root id)
//   2 REMOVE take `entry` out of the stack; its instances stay alive until its exit animation ends
//   3 CLEAR  take every entry out (a reset is CLEAR + PUSH... in one batch; a replace is REMOVE + PUSH)
//   4 EXIT   the stack's last screen was backed out of: let the system handle back (leave the app)
//   5 BACK_ANSWERED  JS has handled the last system back press (stops native's 300 ms fallback)
//   6 IMPRESSIONS    the screen `entry` tracks impressions; params = {"threshold":0.35,"minMs":0} (useImpressions)
//   7 FAILED         the screen `entry` threw while being built; native shows its error screen instead (step 3.9);
//                    params = {"message":"..."}. Try again: native makes a fresh root and sends app event RETRY (10)
//   8 STARTED        JS has built the first screens native asked for (app event START); entry 0. The OTA safety
//                    nets (step 4.7) count a bundle as "on screen" from here (host API 3)
// A NAV op is structural: it keeps its place in the batch and is never merged.
//
// List ops (<List>, docs/lists.md): the list is node `node` of `instance`. LIST_SET gives native every row's key and
// type (the row template id: for Compose's per-kind reuse and the right placeholder); LIST_SPLICE changes a range
// (native keeps the scroll anchored to the first visible key); LIST_ROW says which mounted instance draws the row
// with `key`. Rows are ordinary MOUNTed instances (parent = instance, anchor = node), mounted by JS only around the
// visible range and REMOVEd when they leave it. Ops arrive in order from one JS thread, so no version numbers.
#pragma once

#include <cstdint>
#include <unordered_map>
#include <vector>

#include "zn/value.h"

namespace zn {

enum class OpCode : uint8_t { Patch = 1, Mount = 2, Remove = 3, Move = 4, Nav = 5, ListSet = 6, ListSplice = 7, ListRow = 8 };
enum class NavKind : uint8_t { Push = 1, Remove = 2, Clear = 3, Exit = 4, BackAnswered = 5, Impressions = 6, Failed = 7, Started = 8 };

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
  uint32_t index = 0;        // MOUNT: position among siblings; MOVE: new position; LIST_SPLICE: first row
  std::vector<Value> values; // MOUNT: initial slot values; LIST_SET / LIST_SPLICE: row keys
  std::vector<uint16_t> types;  // LIST_SET / LIST_SPLICE: row template ids (same length as values)
  uint32_t removeCount = 0;  // LIST_SPLICE
  uint32_t row = 0;          // LIST_ROW: the row's instance (key in `value`, list node in `slot`)
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
  void listSet(uint32_t instance, uint16_t node, std::vector<Value> keys, std::vector<uint16_t> types);
  void listSplice(uint32_t instance, uint16_t node, uint32_t index, uint32_t removeCount, std::vector<Value> keys,
                  std::vector<uint16_t> types);
  void listRow(uint32_t instance, uint16_t node, Value key, uint32_t row);

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
