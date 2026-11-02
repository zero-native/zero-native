// The JS engine boundary (ARCHITECTURE.md §7.2).
// The rest of zero-native talks to the engine only through this file; no engine types leak out.
// Every call must happen on the JS thread: engines are single-threaded.
#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include "zn/flowstore.h"
#include "zn/value.h"

namespace zn {

// A block of bytes that stays valid while `owner` is alive.
// The owner can be a memory-mapped asset, a file mapping or a vector; the engine keeps it as long as it needs it.
struct Bytes {
  const uint8_t* data = nullptr;
  size_t size = 0;
  std::shared_ptr<const void> owner;
};

// Result of running code: `value` is the result as text when `ok`, else the error message (and JS stack if any).
struct EvalResult {
  bool ok = false;
  std::string value;
};

// What JS can call. The engine installs these as global functions (names in hermes_engine.cpp) and forwards
// each call here. Implemented by zn::Runtime.
class HostApi {
 public:
  virtual ~HostApi() = default;
  // Batch ops (ARCHITECTURE §8.3).
  virtual void patch(uint32_t instance, uint16_t slot, Value value) = 0;
  virtual void mount(uint16_t templateId, uint32_t parent, uint16_t anchor, uint32_t instance, uint32_t index,
                     std::vector<Value> values) = 0;
  virtual void remove(uint32_t instance) = 0;
  virtual void move(uint32_t instance, uint32_t toIndex) = 0;
  // Back-stack change (NAV op, batch.h): kind is a NavKind, params a JSON string or null.
  virtual void nav(uint8_t kind, uint32_t entry, uint16_t route, Value params) = 0;
  // <List> ops (batch.h): row keys + types, a splice of them, and which instance draws a row.
  virtual void listSet(uint32_t instance, uint16_t node, std::vector<Value> keys, std::vector<uint16_t> types) = 0;
  virtual void listSplice(uint32_t instance, uint16_t node, uint32_t index, uint32_t removeCount,
                          std::vector<Value> keys, std::vector<uint16_t> types) = 0;
  virtual void listRow(uint32_t instance, uint16_t node, Value key, uint32_t row) = 0;
  // Native module call (ARCHITECTURE §15.1); the result comes back later as an app event (runtime.h Platform).
  // `bytes`: raw binary input (an ArrayBuffer from JS, e.g. a fetch body), or nullopt when JS passed none.
  virtual void call(std::string_view module, std::string_view method, std::string_view argsJson,
                    uint32_t callbackId, std::optional<std::span<const uint8_t>> bytes) = 0;
  virtual void cancelCall(uint32_t callbackId) = 0;
  // FlowStore (ARCHITECTURE §13): synchronous on the JS thread (memory copies, microseconds).
  virtual bool storeWrite(std::string_view key, std::string_view payload, std::string* error) = 0;
  virtual FlowStore::ReadResult storeRead(std::string_view key) = 0;
  virtual std::vector<std::string> storeList() = 0;
  virtual bool storeRemove(std::string_view key) = 0;
  // App storage (ARCHITECTURE §13.1, storage.h): synchronous on the JS thread. Values are tagged blobs (storage.h).
  virtual bool storageSet(std::string_view id, std::string_view key, std::span<const uint8_t> tagged) = 0;
  virtual std::optional<std::vector<uint8_t>> storageGet(std::string_view id, std::string_view key) = 0;
  virtual bool storageHas(std::string_view id, std::string_view key) = 0;
  virtual bool storageRemove(std::string_view id, std::string_view key) = 0;
  virtual std::vector<std::string> storageKeys(std::string_view id) = 0;
  virtual void storageClear(std::string_view id) = 0;
  virtual void storageFlush(std::string_view id) = 0;
  // Timers (ARCHITECTURE §14): returns a handle that never changes for the life of the timer.
  virtual uint32_t setTimer(double delayMs, bool repeat) = 0;
  virtual void clearTimer(uint32_t handle) = 0;
  // Misc.
  virtual void log(int level, std::string_view message) = 0;
  // JS caught an error it can't handle (a throwing event handler, timer, effect): logged, and shown on the dev
  // error screen in debug builds (Platform::jsError). `kind`: "screen", "part", "async" or "handler"
  // (packages/core/src/errors.ts).
  virtual void jsError(std::string_view kind, std::string_view where, std::string_view details) = 0;
  virtual double nowMs() = 0;
};

class Engine {
 public:
  virtual ~Engine() = default;

  // Runs precompiled bytecode. Microtasks (Promise callbacks) are drained before returning.
  virtual EvalResult evalBytecode(const Bytes& bytecode, std::string_view url) = 0;

  // Calls a global JS function (for example "__zn_onEvent"). Microtasks are drained before returning.
  // Returns an error result (not an exception) if the function is missing or throws.
  virtual EvalResult callGlobal(std::string_view name, std::span<const Value> args) = 0;

  // Like callGlobal, with `bytes` added as a last argument: a JS ArrayBuffer that owns the vector (no copy).
  virtual EvalResult callGlobalBytes(std::string_view name, std::span<const Value> args,
                                     std::vector<uint8_t> bytes) = 0;

  // Runs queued microtasks. Called after every entry into JS (ARCHITECTURE §7.2, v0 lesson).
  virtual void drainMicrotasks() = 0;

  // A time limit for each entry into JS (an event, a timer, building a screen; step 3.9). 0 = none. An entry that
  // runs longer is stopped: it returns an error whose text starts with kTimeLimitError. Bytecode must be compiled
  // with async break checks (hermesc -emit-async-break-check), or loops can't be interrupted.
  virtual void setTimeLimit(uint32_t /* ms */) {}
};

// The start of the error text of a JS entry stopped by the time limit (Engine::setTimeLimit).
inline constexpr const char* kTimeLimitError = "zero-native time limit:";

using EngineFactory = std::function<std::unique_ptr<Engine>(HostApi&)>;

// Creates the Hermes engine with the settings zero-native requires (microtask queue on) and the host functions.
std::unique_ptr<Engine> createHermesEngine(HostApi& host);

// The Hermes bytecode format this engine runs (99 for Hermes 260318099). Bytecode must match it exactly. Part of the
// app's capabilities for OTA bundles (docs/ota.md §3.2).
uint32_t hermesBytecodeVersion();

// The JS ↔ native contract that a bundle's `@zero-native/core` relies on: the `__zn_*` host functions, app event
// numbers, the batch and value formats. Raise kHostApiVersion when any of them gains something (packages/core/src/
// host-api.ts must say the same number); raise kHostApiOldest only when something is removed or changes meaning,
// which makes every bundle built before it refuse to run on this app (docs/ota.md §3.2).
inline constexpr uint32_t kHostApiVersion = 5;  // 2: NAV FAILED, app event RETRY (step 3.9); 3: NAV STARTED (4.7);
                                                // 4: NAV RESTORE, START "values" (restorableSignal);
                                                // 5: app event APP_STATE (H.7)
inline constexpr uint32_t kHostApiOldest = 1;

}  // namespace zn
