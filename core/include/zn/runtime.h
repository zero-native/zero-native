// zn::Runtime: one per app process (ARCHITECTURE.md §8.2). Owns the engine, the batch and the timers.
//
// Threads:
//   JS thread  — evalBytecode, dispatchEvent, fireTimer (and everything JS calls back into).
//   UI thread  — takeBatch only.
// After every entry into JS the runtime ends the tick: microtasks are drained, the tick's ops are merged into the
// pending batch, and the UI thread is asked (once) to take it.
#pragma once

#include <cstdint>
#include <memory>
#include <mutex>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "zn/batch.h"
#include "zn/engine.h"

namespace zn {

// What the host platform (Android, iOS, tests) provides to the runtime.
class Platform {
 public:
  virtual ~Platform() = default;
  // Calls Runtime::fireTimer(handle) on the JS thread after `delayMs`.
  virtual void scheduleTimer(uint32_t handle, double delayMs) = 0;
  // Asks the UI thread to call Runtime::takeBatch() and apply the result.
  virtual void requestApply() = 0;
  // level: 0 debug, 1 info, 2 warn, 3 error.
  virtual void log(int level, std::string_view message) = 0;
  virtual double nowMs() = 0;
};

class Runtime final : private HostApi {
 public:
  Runtime(Platform& platform, const EngineFactory& engineFactory);
  ~Runtime() override;

  // JS thread.
  EvalResult evalBytecode(const Bytes& bytecode, std::string_view url);
  void dispatchEvent(uint32_t instance, uint16_t eventId, const Value& payload);
  void fireTimer(uint32_t handle);
  size_t activeTimers() const { return timers_.size(); }

  // UI thread: the pending batch as bytes (see batch.h), or empty if there is nothing to apply.
  std::vector<uint8_t> takeBatch();

 private:
  // HostApi (called by JS, on the JS thread).
  void patch(uint32_t instance, uint16_t slot, Value value) override;
  void mount(uint16_t templateId, uint32_t parent, uint16_t anchor, uint32_t instance, uint32_t index,
             std::vector<Value> values) override;
  void remove(uint32_t instance) override;
  void move(uint32_t instance, uint32_t toIndex) override;
  void nav(uint8_t kind, uint32_t entry, uint16_t route, Value params) override;
  uint32_t setTimer(double delayMs, bool repeat) override;
  void clearTimer(uint32_t handle) override;
  void log(int level, std::string_view message) override;
  double nowMs() override;

  void endTick();

  struct Timer {
    double intervalMs = 0;
    bool repeat = false;
  };

  Platform& platform_;
  std::unique_ptr<Engine> engine_;

  Batch tick_;                                 // JS thread only: ops of the current tick
  std::unordered_map<uint32_t, Timer> timers_; // JS thread only
  uint32_t nextTimer_ = 1;

  std::mutex pendingMutex_;                    // guards pending_ and applyRequested_ (JS + UI threads)
  Batch pending_;
  bool applyRequested_ = false;
};

}  // namespace zn
