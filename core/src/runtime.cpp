#include "zn/runtime.h"

#include <array>
#include <string>
#include <utility>

namespace zn {

Runtime::Runtime(Platform& platform, const EngineFactory& engineFactory)
    : platform_(platform), engine_(engineFactory(*this)) {}

Runtime::~Runtime() = default;

namespace {
// An entry JS didn't finish: "hang" if the time limit stopped it (Engine::setTimeLimit), else [otherwise].
std::string_view failureKind(const EvalResult& result, std::string_view otherwise) {
  return std::string_view(result.value).starts_with(kTimeLimitError) ? "hang" : otherwise;
}
}  // namespace

EvalResult Runtime::evalBytecode(const Bytes& bytecode, std::string_view url) {
  EvalResult result = engine_->evalBytecode(bytecode, url);
  if (!result.ok) {
    platform_.jsError(failureKind(result, "start"), "script " + std::string(url) + " failed", result.value);
  }
  endTick();
  return result;
}

void Runtime::dispatchEvent(uint32_t instance, uint16_t eventId, const Value& payload) {
  const std::array<Value, 3> args{Value::number(instance), Value::number(eventId), payload};
  EvalResult result = engine_->callGlobal("__zn_onEvent", args);
  if (!result.ok) platform_.jsError(failureKind(result, "handler"), "event handler failed", result.value);
  endTick();
}

void Runtime::dispatchBytes(uint32_t instance, uint16_t eventId, std::vector<uint8_t> bytes) {
  const std::array<Value, 2> args{Value::number(instance), Value::number(eventId)};
  EvalResult result = engine_->callGlobalBytes("__zn_onEvent", args, std::move(bytes));
  if (!result.ok) platform_.jsError(failureKind(result, "handler"), "event handler failed", result.value);
  endTick();
}

void Runtime::fireTimer(uint32_t handle) {
  auto it = timers_.find(handle);
  if (it == timers_.end()) return;  // cleared: a queued fire never runs (ARCHITECTURE §14, "clear always wins")

  // Keep the same logical handle for a repeating timer; schedule the next fire before running JS, so a
  // clearInterval inside the callback simply removes it again.
  if (it->second.repeat) {
    platform_.scheduleTimer(handle, it->second.intervalMs);
  } else {
    timers_.erase(it);
  }

  const std::array<Value, 1> args{Value::number(handle)};
  EvalResult result = engine_->callGlobal("__zn_onTimer", args);
  if (!result.ok) platform_.jsError(failureKind(result, "handler"), "timer callback failed", result.value);
  endTick();
}

std::vector<uint8_t> Runtime::takeBatch() {
  std::lock_guard<std::mutex> lock(pendingMutex_);
  applyRequested_ = false;
  if (pending_.empty()) return {};
  std::vector<uint8_t> bytes = pending_.encode();
  pending_.clear();
  return bytes;
}

void Runtime::endTick() {
  engine_->drainMicrotasks();
  if (tick_.empty()) return;

  bool request = false;
  {
    std::lock_guard<std::mutex> lock(pendingMutex_);
    // If the UI thread hasn't taken the previous batch yet, this tick is merged into it (coalescing).
    pending_.append(tick_);
    if (!applyRequested_) {
      applyRequested_ = true;
      request = true;
    }
  }
  tick_.clear();
  if (request) platform_.requestApply();
}

void Runtime::patch(uint32_t instance, uint16_t slot, Value value) { tick_.patch(instance, slot, std::move(value)); }

void Runtime::mount(uint16_t templateId, uint32_t parent, uint16_t anchor, uint32_t instance, uint32_t index,
                    std::vector<Value> values) {
  tick_.mount(templateId, parent, anchor, instance, index, std::move(values));
}

void Runtime::remove(uint32_t instance) { tick_.remove(instance); }

void Runtime::move(uint32_t instance, uint32_t toIndex) { tick_.move(instance, toIndex); }

void Runtime::nav(uint8_t kind, uint32_t entry, uint16_t route, Value params) {
  if (kind < static_cast<uint8_t>(NavKind::Push) || kind > static_cast<uint8_t>(NavKind::Failed)) {
    platform_.log(3, "nav: unknown kind " + std::to_string(kind));
    return;
  }
  tick_.nav(static_cast<NavKind>(kind), entry, route, std::move(params));
}

void Runtime::listSet(uint32_t instance, uint16_t node, std::vector<Value> keys, std::vector<uint16_t> types) {
  tick_.listSet(instance, node, std::move(keys), std::move(types));
}

void Runtime::listSplice(uint32_t instance, uint16_t node, uint32_t index, uint32_t removeCount,
                         std::vector<Value> keys, std::vector<uint16_t> types) {
  tick_.listSplice(instance, node, index, removeCount, std::move(keys), std::move(types));
}

void Runtime::listRow(uint32_t instance, uint16_t node, Value key, uint32_t row) {
  tick_.listRow(instance, node, std::move(key), row);
}

void Runtime::call(std::string_view module, std::string_view method, std::string_view argsJson,
                   uint32_t callbackId, std::optional<std::span<const uint8_t>> bytes) {
  platform_.callNative(module, method, argsJson, callbackId, bytes);
}

void Runtime::cancelCall(uint32_t callbackId) { platform_.cancelNative(callbackId); }

FlowStore& Runtime::flowStore() {
  if (!flowStore_) flowStore_ = std::make_unique<FlowStore>(platform_.flowStoreDir());
  return *flowStore_;
}

bool Runtime::storeWrite(std::string_view key, std::string_view payload, std::string* error) {
  const bool ok = flowStore().write(key, payload, error);
  if (!ok) platform_.log(3, "flowstore: write of \"" + std::string(key) + "\" failed: " + (error ? *error : ""));
  return ok;
}

FlowStore::ReadResult Runtime::storeRead(std::string_view key) { return flowStore().read(key); }

std::vector<std::string> Runtime::storeList() { return flowStore().list(); }

bool Runtime::storeRemove(std::string_view key) { return flowStore().remove(key); }

Storage& Runtime::storage() {
  if (!storage_) {
    storage_ = std::make_unique<Storage>(platform_.storageDir(),
                                         [this](int level, std::string_view m) { platform_.log(level, m); });
  }
  return *storage_;
}

bool Runtime::storageSet(std::string_view id, std::string_view key, std::span<const uint8_t> tagged) {
  const bool ok = storage().set(id, key, tagged);
  if (!ok) platform_.log(3, "storage: saving \"" + std::string(key) + "\" in \"" + std::string(id) + "\" failed");
  return ok;
}

std::optional<std::vector<uint8_t>> Runtime::storageGet(std::string_view id, std::string_view key) {
  return storage().get(id, key);
}

bool Runtime::storageHas(std::string_view id, std::string_view key) { return storage().has(id, key); }

bool Runtime::storageRemove(std::string_view id, std::string_view key) { return storage().remove(id, key); }

std::vector<std::string> Runtime::storageKeys(std::string_view id) { return storage().keys(id); }

void Runtime::storageClear(std::string_view id) { storage().clear(id); }

void Runtime::storageFlush(std::string_view id) { storage().flush(id); }

uint32_t Runtime::setTimer(double delayMs, bool repeat) {
  const uint32_t handle = nextTimer_++;
  // A repeating timer with no delay would spin forever; give it at least 1 ms.
  const double delay = delayMs < 0 ? 0 : (repeat && delayMs < 1 ? 1 : delayMs);
  timers_[handle] = Timer{delay, repeat};
  platform_.scheduleTimer(handle, delay);
  return handle;
}

void Runtime::clearTimer(uint32_t handle) { timers_.erase(handle); }

void Runtime::log(int level, std::string_view message) { platform_.log(level, message); }

void Runtime::jsError(std::string_view kind, std::string_view where, std::string_view details) {
  platform_.jsError(kind, where, details);
}

double Runtime::nowMs() { return platform_.nowMs(); }

}  // namespace zn
