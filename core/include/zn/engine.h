// The JS engine boundary (ARCHITECTURE.md §7.2).
// The rest of zero-native talks to the engine only through this file; no engine types leak out.
// Every call must happen on the JS thread: engines are single-threaded.
#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <span>
#include <string>
#include <string_view>
#include <vector>

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
  // Timers (ARCHITECTURE §14): returns a handle that never changes for the life of the timer.
  virtual uint32_t setTimer(double delayMs, bool repeat) = 0;
  virtual void clearTimer(uint32_t handle) = 0;
  // Misc.
  virtual void log(int level, std::string_view message) = 0;
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

  // Runs queued microtasks. Called after every entry into JS (ARCHITECTURE §7.2, v0 lesson).
  virtual void drainMicrotasks() = 0;
};

using EngineFactory = std::function<std::unique_ptr<Engine>(HostApi&)>;

// Creates the Hermes engine with the settings zero-native requires (microtask queue on) and the host functions.
std::unique_ptr<Engine> createHermesEngine(HostApi& host);

}  // namespace zn
