#include "zn/batch.h"

#include <cstring>
#include <utility>

namespace zn {
namespace {

uint64_t patchKey(uint32_t instance, uint16_t slot) {
  return (static_cast<uint64_t>(instance) << 16) | slot;
}

class Writer {
 public:
  void u8(uint8_t v) { bytes_.push_back(v); }
  void u16(uint16_t v) { raw(&v, sizeof v); }
  void u32(uint32_t v) { raw(&v, sizeof v); }
  void f64(double v) { raw(&v, sizeof v); }
  void value(const Value& v) {
    switch (v.kind()) {
      case Value::Kind::Null: u8(0); break;
      case Value::Kind::Bool: u8(v.asBool() ? 2 : 1); break;
      case Value::Kind::Number: u8(3); f64(v.asNumber()); break;
      case Value::Kind::String: {
        u8(4);
        u32(static_cast<uint32_t>(v.asString().size()));
        raw(v.asString().data(), v.asString().size());
        break;
      }
    }
  }
  std::vector<uint8_t> take() { return std::move(bytes_); }

 private:
  // Android and iOS devices are little-endian, so memcpy writes the documented byte order.
  void raw(const void* p, size_t n) {
    const auto* b = static_cast<const uint8_t*>(p);
    bytes_.insert(bytes_.end(), b, b + n);
  }
  std::vector<uint8_t> bytes_;
};

}  // namespace

void Batch::push(Op op) {
  if (op.code == OpCode::Patch) {
    const uint64_t key = patchKey(op.instance, op.slot);
    auto it = patchIndex_.find(key);
    if (it != patchIndex_.end()) {
      ops_[it->second].value = std::move(op.value);
      return;
    }
    patchIndex_[key] = ops_.size();
  }
  ops_.push_back(std::move(op));
}

void Batch::patch(uint32_t instance, uint16_t slot, Value value) {
  Op op;
  op.code = OpCode::Patch;
  op.instance = instance;
  op.slot = slot;
  op.value = std::move(value);
  push(std::move(op));
}

void Batch::mount(uint16_t templateId, uint32_t parent, uint16_t anchor, uint32_t instance, uint32_t index,
                  std::vector<Value> values) {
  Op op;
  op.code = OpCode::Mount;
  op.templateId = templateId;
  op.parent = parent;
  op.anchor = anchor;
  op.instance = instance;
  op.index = index;
  op.values = std::move(values);
  push(std::move(op));
}

void Batch::remove(uint32_t instance) {
  Op op;
  op.code = OpCode::Remove;
  op.instance = instance;
  push(std::move(op));
}

void Batch::move(uint32_t instance, uint32_t toIndex) {
  Op op;
  op.code = OpCode::Move;
  op.instance = instance;
  op.index = toIndex;
  push(std::move(op));
}

void Batch::append(const Batch& other) {
  for (const Op& op : other.ops_) push(op);
}

void Batch::clear() {
  ops_.clear();
  patchIndex_.clear();
}

std::vector<uint8_t> Batch::encode() const {
  Writer w;
  w.u32(kBatchMagic);
  w.u32(static_cast<uint32_t>(ops_.size()));
  for (const Op& op : ops_) {
    w.u8(static_cast<uint8_t>(op.code));
    switch (op.code) {
      case OpCode::Patch:
        w.u32(op.instance);
        w.u16(op.slot);
        w.value(op.value);
        break;
      case OpCode::Mount:
        w.u16(op.templateId);
        w.u32(op.parent);
        w.u16(op.anchor);
        w.u32(op.instance);
        w.u32(op.index);
        w.u16(static_cast<uint16_t>(op.values.size()));
        for (const Value& v : op.values) w.value(v);
        break;
      case OpCode::Remove:
        w.u32(op.instance);
        break;
      case OpCode::Move:
        w.u32(op.instance);
        w.u32(op.index);
        break;
    }
  }
  return w.take();
}

}  // namespace zn
