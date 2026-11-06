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
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "zn/batch.h"
#include "zn/engine.h"
#include "zn/storage.h"

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
  // A native module call from JS (ARCHITECTURE §15.1). The platform runs it off the JS and UI threads and later
  // delivers the result to JS with dispatchEvent(0, 7, {"id", "ok", "value" | "error"}), or, for an answer with
  // binary data, dispatchBytes(0, 9, ...). `bytes`: binary input from JS, if any. Must not block.
  virtual void callNative(std::string_view module, std::string_view method, std::string_view argsJson,
                          uint32_t callbackId, std::optional<std::span<const uint8_t>> bytes) = 0;
  // JS gave up on a call (AbortSignal, or its screen closed): the platform marks it cancelled and drops its reply.
  virtual void cancelNative(uint32_t callbackId) = 0;
  // An existing, app-private folder for FlowStore files, excluded from backups (Android: noBackupFilesDir/zn).
  virtual std::string flowStoreDir() = 0;
  // An existing, app-private folder for app storage (MMKV files), excluded from backups
  // (Android: noBackupFilesDir/zn-storage).
  virtual std::string storageDir() = 0;
  virtual double nowMs() = 0;
  // JS threw and nothing caught it, or it hung or didn't start. `kind`: what was running ("screen", "part",
  // "async", "handler" from JS; "hang" when the time limit stopped it; "start" when a script failed). `details`
  // is the message and the JS stack. Debug builds show it on screen (`zn dev`); the default only logs it.
  virtual void jsError(std::string_view kind, std::string_view where, std::string_view details) {
    log(3, std::string(where) + " [" + std::string(kind) + "]: " + std::string(details));
  }
};

class Runtime final : private HostApi {
 public:
  Runtime(Platform& platform, const EngineFactory& engineFactory);
  ~Runtime() override;

  // JS thread.
  EvalResult evalBytecode(const Bytes& bytecode, std::string_view url);
  void dispatchEvent(uint32_t instance, uint16_t eventId, const Value& payload);
  // Same, with binary data: JS gets `bytes` as an ArrayBuffer payload (no copy).
  void dispatchBytes(uint32_t instance, uint16_t eventId, std::vector<uint8_t> bytes);
  void fireTimer(uint32_t handle);
  size_t activeTimers() const { return timers_.size(); }
  // Each entry into JS may run at most `ms` (0 = no limit); see Engine::setTimeLimit.
  void setTimeLimit(uint32_t ms) { engine_->setTimeLimit(ms); }
  // See Engine::setGlobalString. JS thread, before the main script.
  void setGlobalString(std::string_view name, std::string_view value) { engine_->setGlobalString(name, value); }

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
  void listSet(uint32_t instance, uint16_t node, std::vector<Value> keys, std::vector<uint16_t> types) override;
  void listSplice(uint32_t instance, uint16_t node, uint32_t index, uint32_t removeCount, std::vector<Value> keys,
                  std::vector<uint16_t> types) override;
  void listRow(uint32_t instance, uint16_t node, Value key, uint32_t row) override;
  void call(std::string_view module, std::string_view method, std::string_view argsJson,
            uint32_t callbackId, std::optional<std::span<const uint8_t>> bytes) override;
  void cancelCall(uint32_t callbackId) override;
  bool storeWrite(std::string_view key, std::string_view payload, std::string* error) override;
  FlowStore::ReadResult storeRead(std::string_view key) override;
  std::vector<std::string> storeList() override;
  bool storeRemove(std::string_view key) override;
  FlowStore& flowStore();
  bool storageSet(std::string_view id, std::string_view key, std::span<const uint8_t> tagged) override;
  std::optional<std::vector<uint8_t>> storageGet(std::string_view id, std::string_view key) override;
  bool storageHas(std::string_view id, std::string_view key) override;
  bool storageRemove(std::string_view id, std::string_view key) override;
  std::vector<std::string> storageKeys(std::string_view id) override;
  void storageClear(std::string_view id) override;
  void storageFlush(std::string_view id) override;
  Storage& storage();
  uint32_t setTimer(double delayMs, bool repeat) override;
  void clearTimer(uint32_t handle) override;
  void log(int level, std::string_view message) override;
  void jsError(std::string_view kind, std::string_view where, std::string_view details) override;
  double nowMs() override;

  void endTick();

  struct Timer {
    double intervalMs = 0;
    bool repeat = false;
  };

  Platform& platform_;
  std::unique_ptr<Engine> engine_;
  std::unique_ptr<FlowStore> flowStore_;      // JS thread only; opened on first use
  std::unique_ptr<Storage> storage_;          // JS thread only; opened on first use

  Batch tick_;                                 // JS thread only: ops of the current tick
  std::unordered_map<uint32_t, Timer> timers_; // JS thread only
  uint32_t nextTimer_ = 1;

  std::mutex pendingMutex_;                    // guards pending_ and applyRequested_ (JS + UI threads)
  Batch pending_;
  bool applyRequested_ = false;
};

}  // namespace zn
