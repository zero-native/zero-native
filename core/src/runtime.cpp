#include "zn/runtime.h"

#include <array>
#include <string>
#include <utility>

namespace zn {

Runtime::Runtime(Platform& platform, const EngineFactory& engineFactory)
    : platform_(platform), engine_(engineFactory(*this)) {}

Runtime::~Runtime() = default;

EvalResult Runtime::evalBytecode(const Bytes& bytecode, std::string_view url) {
  EvalResult result = engine_->evalBytecode(bytecode, url);
  endTick();
  return result;
}

void Runtime::dispatchEvent(uint32_t instance, uint16_t eventId, const Value& payload) {
  const std::array<Value, 3> args{Value::number(instance), Value::number(eventId), payload};
  EvalResult result = engine_->callGlobal("__zn_onEvent", args);
  if (!result.ok) platform_.log(3, "event handler failed: " + result.value);
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
  if (!result.ok) platform_.log(3, "timer callback failed: " + result.value);
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
  if (kind < static_cast<uint8_t>(NavKind::Push) || kind > static_cast<uint8_t>(NavKind::BackAnswered)) {
    platform_.log(3, "nav: unknown kind " + std::to_string(kind));
    return;
  }
  tick_.nav(static_cast<NavKind>(kind), entry, route, std::move(params));
}

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

double Runtime::nowMs() { return platform_.nowMs(); }

}  // namespace zn
