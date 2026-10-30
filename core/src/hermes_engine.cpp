// Hermes implementation of zn::Engine. JSI is used only inside this file.
//
// JS globals installed here (the JS side of each is in packages/core/src/native.ts):
//   __zn_patch(instance, slot, value)
//   __zn_mount(templateId, parent, anchor, instance, index, values[])
//   __zn_remove(instance)
//   __zn_move(instance, toIndex)
//   __zn_nav(kind, entry, route, paramsJson)
//   __zn_listSet(instance, node, keys[], types[]) / __zn_listSplice(instance, node, index, removeCount, keys[], types[])
//   __zn_listRow(instance, node, key, rowInstance)
//   __zn_call(module, method, argsJson, callbackId[, buffer, offset, length])
//       (result: app event 7, or 9 with an ArrayBuffer; see runtime.h Platform::callNative)
//   __zn_cancel(callbackId)
//   __zn_utf8Decode(buffer, offset, length, fatal) -> string (bad bytes → U+FFFD; undefined if fatal and bad)
//   __zn_utf8Encode(string) -> ArrayBuffer
//   __zn_store_write(key, json) / __zn_store_read(key) / __zn_store_list() / __zn_store_remove(key)   (FlowStore)
//   __zn_kv_set(id, key, value[, offset, length]) -> bool / __zn_kv_get(id, key) -> value | undefined /
//   __zn_kv_has(id, key) / __zn_kv_delete(id, key) / __zn_kv_keys(id) -> string[] / __zn_kv_clear(id) /
//   __zn_kv_flush(id)
//       (app storage, storage.h; value: string, number, boolean or an ArrayBuffer range)
//   __zn_setTimer(delayMs, repeat) -> handle
//   __zn_clearTimer(handle)
//   __zn_log(level, message)
//   __zn_now() -> ms
// Called by native (defined by the JS runtime): __zn_onEvent(instance, eventId, payload), __zn_onTimer(handle).
#include "zn/engine.h"
#include "zn/storage.h"
#include "zn/utf8.h"

#include <hermes/hermes.h>
#include <jsi/jsi.h>

#include <algorithm>
#include <atomic>
#include <bit>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <cstdint>
#include <cstring>
#include <exception>
#include <string>
#include <utility>
#include <vector>

namespace zn {
namespace {

namespace jsi = facebook::jsi;

// Hermes V1 moved runtime-independent helpers (bytecode checks) to the root API. It has static lifetime.
facebook::hermes::IHermesRootAPI* rootApi() {
  static auto* api =
      jsi::castInterface<facebook::hermes::IHermesRootAPI>(facebook::hermes::makeHermesRootAPI());
  return api;
}

// Gives Hermes a view of our bytes without copying them. Keeps the owner alive as long as Hermes holds the buffer.
class BytesBuffer final : public jsi::Buffer {
 public:
  explicit BytesBuffer(Bytes bytes) : bytes_(std::move(bytes)) {}
  size_t size() const override { return bytes_.size; }
  const uint8_t* data() const override { return bytes_.data; }

 private:
  Bytes bytes_;
};

// An ArrayBuffer's memory, owned by a vector we give away to Hermes (no copy).
class VectorBuffer final : public jsi::MutableBuffer {
 public:
  explicit VectorBuffer(std::vector<uint8_t> bytes) : bytes_(std::move(bytes)) {}
  size_t size() const override { return bytes_.size(); }
  uint8_t* data() override { return bytes_.empty() ? &empty_ : bytes_.data(); }

 private:
  std::vector<uint8_t> bytes_;
  uint8_t empty_ = 0;  // a valid pointer for a 0-byte buffer
};

jsi::ArrayBuffer makeArrayBuffer(jsi::Runtime& rt, std::vector<uint8_t> bytes) {
  return jsi::ArrayBuffer(rt, std::make_shared<VectorBuffer>(std::move(bytes)));
}

// (buffer, offset, length) arguments starting at a[i] → the bytes they name, checked against the buffer's size.
std::span<const uint8_t> bufferArgs(jsi::Runtime& rt, const jsi::Value* a, size_t n, size_t i) {
  if (i >= n || !a[i].isObject() || !a[i].getObject(rt).isArrayBuffer(rt)) {
    throw jsi::JSError(rt, "zero-native: expected an ArrayBuffer");
  }
  jsi::ArrayBuffer buffer = a[i].getObject(rt).getArrayBuffer(rt);
  const size_t size = buffer.size(rt);
  const double offset = (i + 1 < n && a[i + 1].isNumber()) ? a[i + 1].getNumber() : 0;
  const double length = (i + 2 < n && a[i + 2].isNumber()) ? a[i + 2].getNumber() : static_cast<double>(size) - offset;
  if (!(offset >= 0 && length >= 0 && offset + length <= static_cast<double>(size))) {
    throw jsi::JSError(rt, "zero-native: buffer range is outside the ArrayBuffer");
  }
  return {buffer.data(rt) + static_cast<size_t>(offset), static_cast<size_t>(length)};
}

// A string argument, or a JSError naming what was expected.
std::string stringArg(jsi::Runtime& rt, const jsi::Value* a, size_t n, size_t i, const char* what) {
  if (i >= n || !a[i].isString()) throw jsi::JSError(rt, std::string("zero-native: expected ") + what);
  return a[i].getString(rt).utf8(rt);
}

// JS string → UTF-8, with a lone surrogate turned into U+FFFD (what TextEncoder does), whatever Hermes wrote for it.
std::string utf8Of(jsi::Runtime& rt, const jsi::String& s) {
  std::string text = s.utf8(rt);
  const auto* p = reinterpret_cast<const uint8_t*>(text.data());
  if (!utf8::valid(p, text.size())) text = utf8::sanitize(p, text.size());
  return text;
}

static_assert(std::endian::native == std::endian::little, "storage numbers are stored little-endian");

// A JS value → a tagged storage blob (storage.h). Bytes come as (ArrayBuffer, offset, length) starting at a[i].
std::vector<uint8_t> toStored(jsi::Runtime& rt, const jsi::Value* a, size_t n, size_t i) {
  std::vector<uint8_t> out;
  const jsi::Value& v = a[i];
  if (v.isString()) {
    const std::string text = utf8Of(rt, v.getString(rt));
    out.reserve(1 + text.size());
    out.push_back(static_cast<uint8_t>(StoredType::String));
    out.insert(out.end(), text.begin(), text.end());
  } else if (v.isNumber()) {
    const double d = v.getNumber();
    out.resize(9);
    out[0] = static_cast<uint8_t>(StoredType::Number);
    std::memcpy(out.data() + 1, &d, 8);
  } else if (v.isBool()) {
    out = {static_cast<uint8_t>(StoredType::Boolean), static_cast<uint8_t>(v.getBool() ? 1 : 0)};
  } else if (v.isObject() && v.getObject(rt).isArrayBuffer(rt)) {
    const std::span<const uint8_t> bytes = bufferArgs(rt, a, n, i);
    out.reserve(1 + bytes.size());
    out.push_back(static_cast<uint8_t>(StoredType::Bytes));
    out.insert(out.end(), bytes.begin(), bytes.end());
  } else {
    throw jsi::JSError(rt, "zero-native: storage values must be a string, number, boolean or bytes");
  }
  return out;
}

// A tagged storage blob → a JS value. An unknown tag (a file written by something else) is an error, never a guess.
jsi::Value fromStored(jsi::Runtime& rt, const std::vector<uint8_t>& blob, const std::string& id, const std::string& key) {
  const size_t size = blob.size();
  const uint8_t tag = size > 0 ? blob[0] : 0;
  if (tag == static_cast<uint8_t>(StoredType::String)) {
    return jsi::String::createFromUtf8(rt, blob.data() + 1, size - 1);
  }
  if (tag == static_cast<uint8_t>(StoredType::Number) && size == 9) {
    double d;
    std::memcpy(&d, blob.data() + 1, 8);
    return jsi::Value(d);
  }
  if (tag == static_cast<uint8_t>(StoredType::Boolean) && size == 2) return jsi::Value(blob[1] != 0);
  if (tag == static_cast<uint8_t>(StoredType::Bytes)) {
    return makeArrayBuffer(rt, std::vector<uint8_t>(blob.begin() + 1, blob.end()));
  }
  throw jsi::JSError(rt, "zero-native: storage \"" + id + "\" key \"" + key + "\" holds data in an unknown format");
}

Value toValue(jsi::Runtime& rt, const jsi::Value& v) {
  if (v.isNull() || v.isUndefined()) return Value::null();
  if (v.isBool()) return Value::boolean(v.getBool());
  if (v.isNumber()) return Value::number(v.getNumber());
  if (v.isString()) return Value::string(v.getString(rt).utf8(rt));
  throw jsi::JSError(rt, "zero-native: only null, boolean, number and string values can be sent to native");
}

jsi::Value toJs(jsi::Runtime& rt, const Value& v) {
  switch (v.kind()) {
    case Value::Kind::Null: return jsi::Value::null();
    case Value::Kind::Bool: return jsi::Value(v.asBool());
    case Value::Kind::Number: return jsi::Value(v.asNumber());
    case Value::Kind::String: return jsi::String::createFromUtf8(rt, v.asString());
  }
  return jsi::Value::null();
}

uint32_t u32Arg(jsi::Runtime& rt, const jsi::Value* args, size_t count, size_t i) {
  if (i >= count || !args[i].isNumber()) throw jsi::JSError(rt, "zero-native: expected a number argument");
  // Casting a negative or too-big double to uint32_t is undefined behaviour in C++: a wrong id must fail loudly,
  // not turn into some other instance id.
  const double d = args[i].getNumber();
  if (!(d >= 0 && d <= 4294967295.0) || d != static_cast<double>(static_cast<uint64_t>(d))) {
    throw jsi::JSError(rt, "zero-native: expected a whole number from 0 to 2^32-1, got " + std::to_string(d));
  }
  return static_cast<uint32_t>(d);
}

class HermesEngine final : public Engine {
 public:
  explicit HermesEngine(HostApi& host)
      // MicrotaskQueue is off by default in Hermes; without it Promise callbacks run late or never.
      : host_(host),
        runtime_(facebook::hermes::makeHermesRuntime(
            ::hermes::vm::RuntimeConfig::Builder().withMicrotaskQueue(true).build())) {
    installHostFunctions();
  }

  ~HermesEngine() override {
    {
      std::lock_guard lock(watchMutex_);
      stopping_ = true;
    }
    watchWake_.notify_all();
    if (watchdog_.joinable()) watchdog_.join();  // before runtime_ goes away
  }

  void setTimeLimit(uint32_t ms) override {
    limitMs_.store(ms);
    if (ms > 0 && !watchdog_.joinable()) watchdog_ = std::thread([this] { watch(); });
    watchWake_.notify_all();
  }

  EvalResult evalBytecode(const Bytes& bytecode, std::string_view url) override {
    if (bytecode.data == nullptr || bytecode.size == 0) {
      return {false, "empty bytecode: " + std::string(url)};
    }
    if (!rootApi()->isHermesBytecode(bytecode.data, bytecode.size)) {
      return {false, "not Hermes bytecode (wrong file or wrong hermesc version?): " + std::string(url)};
    }
    return guard(std::string("script ") + std::string(url), [&] {
      auto buffer = std::make_shared<BytesBuffer>(bytecode);
      jsi::Value result = runtime_->evaluateJavaScript(buffer, std::string(url));
      runtime_->drainMicrotasks();
      return describe(result);
    });
  }

  EvalResult callGlobal(std::string_view name, std::span<const Value> args) override {
    return guard(entryLabel(name), [&] {
      jsi::Runtime& rt = *runtime_;
      jsi::Value fn = rt.global().getProperty(rt, std::string(name).c_str());
      if (!fn.isObject() || !fn.getObject(rt).isFunction(rt)) {
        throw jsi::JSError(rt, "global function not defined: " + std::string(name));
      }
      std::vector<jsi::Value> jsArgs;
      jsArgs.reserve(args.size());
      for (const Value& a : args) jsArgs.push_back(toJs(rt, a));
      const jsi::Value* argv = jsArgs.empty() ? nullptr : jsArgs.data();
      jsi::Value result = fn.getObject(rt).getFunction(rt).call(rt, argv, jsArgs.size());
      runtime_->drainMicrotasks();
      return describe(result);
    });
  }

  EvalResult callGlobalBytes(std::string_view name, std::span<const Value> args,
                             std::vector<uint8_t> bytes) override {
    return guard(entryLabel(name), [&] {
      jsi::Runtime& rt = *runtime_;
      jsi::Value fn = rt.global().getProperty(rt, std::string(name).c_str());
      if (!fn.isObject() || !fn.getObject(rt).isFunction(rt)) {
        throw jsi::JSError(rt, "global function not defined: " + std::string(name));
      }
      std::vector<jsi::Value> jsArgs;
      jsArgs.reserve(args.size() + 1);
      for (const Value& a : args) jsArgs.push_back(toJs(rt, a));
      jsArgs.emplace_back(makeArrayBuffer(rt, std::move(bytes)));
      const jsi::Value* argv = jsArgs.data();  // const: picks call(rt, args, count), not the variadic call
      jsi::Value result = fn.getObject(rt).getFunction(rt).call(rt, argv, jsArgs.size());
      runtime_->drainMicrotasks();
      return describe(result);
    });
  }

  void drainMicrotasks() override {
    Entry entry(*this, "promise callbacks");
    runtime_->drainMicrotasks();
  }

 private:
  // Marks one entry into JS for the time limit. Nested entries (JS → native → JS) count as the outer one.
  struct Entry {
    Entry(HermesEngine& e, std::string label) : engine(e), what(std::move(label)) {
      if (engine.depth_++ == 0) {
        engine.timedOut_.store(false);
        engine.entryStart_.store(steadyMs());
      }
    }
    ~Entry() {
      if (--engine.depth_ != 0) return;
      const int64_t ms = steadyMs() - engine.entryStart_.load();
      engine.entryStart_.store(0);
      // The UI keeps working while JS is busy, but taps wait: say so before the time limit has to step in.
      if (ms >= kSlowEntryMs && !engine.timedOut_.load()) {
        engine.host_.log(2, "slow JS: " + what + " ran for " + std::to_string(ms) + " ms (taps wait meanwhile; it is "
                                "stopped after " + std::to_string(engine.limitMs_.load()) + " ms)");
      }
    }
    HermesEngine& engine;
    std::string what;
  };

  static int64_t steadyMs() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count() + 1;  // never 0
  }

  // The watchdog thread: wakes a few times per limit and stops an entry that runs too long. Hermes can be
  // interrupted from any thread (asyncTriggerTimeout); the running JS then throws at its next break check.
  void watch() {
    std::unique_lock lock(watchMutex_);
    while (!stopping_) {
      const uint32_t limit = limitMs_.load();
      watchWake_.wait_for(lock, std::chrono::milliseconds(limit > 0 ? std::max<uint32_t>(limit / 5, 20) : 1000));
      if (stopping_ || limit == 0) continue;
      const int64_t start = entryStart_.load();
      if (start != 0 && !timedOut_.load() && steadyMs() - start > static_cast<int64_t>(limit)) {
        timedOut_.store(true);
        runtime_->asyncTriggerTimeout();
      }
    }
  }

  // For the slow-task warning: what native called.
  static std::string entryLabel(std::string_view global) {
    if (global == "__zn_onEvent") return "an event (tap, native answer, ...)";
    if (global == "__zn_onTimer") return "a timer";
    return std::string(global);
  }

  template <typename F>
  EvalResult guard(std::string label, F&& body) {
    Entry entry(*this, std::move(label));
    try {
      return {true, body()};
    } catch (const jsi::JSError& e) {
      return {false, failure(e.getMessage() + "\n" + e.getStack())};
    } catch (const std::exception& e) {
      return {false, failure(e.what())};
    }
  }

  // An entry the watchdog stopped says so first, so the platform can treat it as a hang (step 3.9).
  std::string failure(std::string details) {
    if (!timedOut_.load()) return details;
    return std::string(kTimeLimitError) + " JS ran longer than " + std::to_string(limitMs_.load()) +
           " ms and was stopped\n" + details;
  }

  std::string describe(const jsi::Value& value) {
    if (value.isUndefined()) return "undefined";
    return value.toString(*runtime_).utf8(*runtime_);
  }

  template <typename F>
  void define(const char* name, unsigned params, F&& fn) {
    jsi::Runtime& rt = *runtime_;
    rt.global().setProperty(
        rt, name,
        jsi::Function::createFromHostFunction(rt, jsi::PropNameID::forAscii(rt, name), params,
                                              std::forward<F>(fn)));
  }

  void installHostFunctions() {
    HostApi& host = host_;
    using Args = const jsi::Value*;

    define("__zn_patch", 3, [&host](jsi::Runtime& rt, const jsi::Value&, Args a, size_t n) -> jsi::Value {
      host.patch(u32Arg(rt, a, n, 0), static_cast<uint16_t>(u32Arg(rt, a, n, 1)),
                 n > 2 ? toValue(rt, a[2]) : Value::null());
      return jsi::Value::undefined();
    });

    define("__zn_mount", 6, [&host](jsi::Runtime& rt, const jsi::Value&, Args a, size_t n) -> jsi::Value {
      std::vector<Value> values;
      if (n > 5 && a[5].isObject()) {
        jsi::Array arr = a[5].getObject(rt).getArray(rt);
        const size_t len = arr.size(rt);
        values.reserve(len);
        for (size_t i = 0; i < len; i++) values.push_back(toValue(rt, arr.getValueAtIndex(rt, i)));
      }
      host.mount(static_cast<uint16_t>(u32Arg(rt, a, n, 0)), u32Arg(rt, a, n, 1),
                 static_cast<uint16_t>(u32Arg(rt, a, n, 2)), u32Arg(rt, a, n, 3), u32Arg(rt, a, n, 4),
                 std::move(values));
      return jsi::Value::undefined();
    });

    define("__zn_remove", 1, [&host](jsi::Runtime& rt, const jsi::Value&, Args a, size_t n) -> jsi::Value {
      host.remove(u32Arg(rt, a, n, 0));
      return jsi::Value::undefined();
    });

    define("__zn_move", 2, [&host](jsi::Runtime& rt, const jsi::Value&, Args a, size_t n) -> jsi::Value {
      host.move(u32Arg(rt, a, n, 0), u32Arg(rt, a, n, 1));
      return jsi::Value::undefined();
    });

    define("__zn_nav", 4, [&host](jsi::Runtime& rt, const jsi::Value&, Args a, size_t n) -> jsi::Value {
      host.nav(static_cast<uint8_t>(u32Arg(rt, a, n, 0)), u32Arg(rt, a, n, 1),
               static_cast<uint16_t>(u32Arg(rt, a, n, 2)), n > 3 ? toValue(rt, a[3]) : Value::null());
      return jsi::Value::undefined();
    });

    // keys: array of strings; types: array of template ids (same length).
    auto rows = [](jsi::Runtime& rt, const jsi::Value* k, const jsi::Value* t, std::vector<Value>& keys,
                   std::vector<uint16_t>& types) {
      if (!k || !t || !k->isObject() || !t->isObject()) {
        throw jsi::JSError(rt, "zero-native: list keys and types must be arrays");
      }
      jsi::Array ka = k->getObject(rt).getArray(rt);
      jsi::Array ta = t->getObject(rt).getArray(rt);
      const size_t n = ka.size(rt);
      if (ta.size(rt) != n) throw jsi::JSError(rt, "zero-native: list keys and types differ in length");
      keys.reserve(n);
      types.reserve(n);
      for (size_t i = 0; i < n; i++) {
        keys.push_back(toValue(rt, ka.getValueAtIndex(rt, i)));
        const jsi::Value ty = ta.getValueAtIndex(rt, i);
        types.push_back(static_cast<uint16_t>(ty.isNumber() ? ty.getNumber() : 0));
      }
    };

    define("__zn_listSet", 4, [&host, rows](jsi::Runtime& rt, const jsi::Value&, Args a, size_t n) -> jsi::Value {
      std::vector<Value> keys;
      std::vector<uint16_t> types;
      rows(rt, n > 2 ? &a[2] : nullptr, n > 3 ? &a[3] : nullptr, keys, types);
      host.listSet(u32Arg(rt, a, n, 0), static_cast<uint16_t>(u32Arg(rt, a, n, 1)), std::move(keys), std::move(types));
      return jsi::Value::undefined();
    });

    define("__zn_listSplice", 6, [&host, rows](jsi::Runtime& rt, const jsi::Value&, Args a, size_t n) -> jsi::Value {
      std::vector<Value> keys;
      std::vector<uint16_t> types;
      rows(rt, n > 4 ? &a[4] : nullptr, n > 5 ? &a[5] : nullptr, keys, types);
      host.listSplice(u32Arg(rt, a, n, 0), static_cast<uint16_t>(u32Arg(rt, a, n, 1)), u32Arg(rt, a, n, 2),
                      u32Arg(rt, a, n, 3), std::move(keys), std::move(types));
      return jsi::Value::undefined();
    });

    define("__zn_listRow", 4, [&host](jsi::Runtime& rt, const jsi::Value&, Args a, size_t n) -> jsi::Value {
      host.listRow(u32Arg(rt, a, n, 0), static_cast<uint16_t>(u32Arg(rt, a, n, 1)),
                   n > 2 ? toValue(rt, a[2]) : Value::null(), u32Arg(rt, a, n, 3));
      return jsi::Value::undefined();
    });

    define("__zn_setTimer", 2, [&host](jsi::Runtime& rt, const jsi::Value&, Args a, size_t n) -> jsi::Value {
      const double delay = (n > 0 && a[0].isNumber()) ? a[0].getNumber() : 0;
      const bool repeat = n > 1 && a[1].isBool() && a[1].getBool();
      return jsi::Value(static_cast<double>(host.setTimer(delay, repeat)));
    });

    define("__zn_clearTimer", 1, [&host](jsi::Runtime& rt, const jsi::Value&, Args a, size_t n) -> jsi::Value {
      if (n > 0 && a[0].isNumber()) host.clearTimer(static_cast<uint32_t>(a[0].getNumber()));
      return jsi::Value::undefined();
    });

    define("__zn_call", 4, [&host](jsi::Runtime& rt, const jsi::Value&, Args a, size_t n) -> jsi::Value {
      if (n < 4 || !a[0].isString() || !a[1].isString() || !a[2].isString()) {
        throw jsi::JSError(rt, "zero-native: __zn_call(module, method, argsJson, callbackId)");
      }
      const std::string module = a[0].getString(rt).utf8(rt);
      const std::string method = a[1].getString(rt).utf8(rt);
      const std::string args = a[2].getString(rt).utf8(rt);
      const uint32_t id = u32Arg(rt, a, n, 3);
      if (n > 4 && !a[4].isUndefined() && !a[4].isNull()) {
        // The bytes are only read during this call (the platform copies them), so a view into the buffer is enough.
        host.call(module, method, args, id, bufferArgs(rt, a, n, 4));
      } else {
        host.call(module, method, args, id, std::nullopt);
      }
      return jsi::Value::undefined();
    });

    define("__zn_utf8Decode", 4, [](jsi::Runtime& rt, const jsi::Value&, Args a, size_t n) -> jsi::Value {
      const std::span<const uint8_t> bytes = bufferArgs(rt, a, n, 0);
      const bool fatal = n > 3 && a[3].isBool() && a[3].getBool();
      if (utf8::valid(bytes.data(), bytes.size())) {
        return jsi::String::createFromUtf8(rt, bytes.data(), bytes.size());
      }
      if (fatal) return jsi::Value::undefined();
      const std::string clean = utf8::sanitize(bytes.data(), bytes.size());
      return jsi::String::createFromUtf8(rt, reinterpret_cast<const uint8_t*>(clean.data()), clean.size());
    });

    define("__zn_utf8Encode", 1, [](jsi::Runtime& rt, const jsi::Value&, Args a, size_t n) -> jsi::Value {
      if (n < 1 || !a[0].isString()) throw jsi::JSError(rt, "zero-native: __zn_utf8Encode(string)");
      std::string s = a[0].getString(rt).utf8(rt);
      // A lone surrogate must become U+FFFD (web TextEncoder). Make sure, whatever Hermes wrote for it.
      if (!utf8::valid(reinterpret_cast<const uint8_t*>(s.data()), s.size())) {
        s = utf8::sanitize(reinterpret_cast<const uint8_t*>(s.data()), s.size());
      }
      return makeArrayBuffer(rt, std::vector<uint8_t>(s.begin(), s.end()));
    });

    // FlowStore. write → true / false; read → string (ok), null (missing) or false (broken); list → string[].
    define("__zn_store_write", 2, [&host](jsi::Runtime& rt, const jsi::Value&, Args a, size_t n) -> jsi::Value {
      if (n < 2 || !a[0].isString() || !a[1].isString()) throw jsi::JSError(rt, "zero-native: __zn_store_write(key, json)");
      std::string error;
      return jsi::Value(host.storeWrite(a[0].getString(rt).utf8(rt), a[1].getString(rt).utf8(rt), &error));
    });

    define("__zn_store_read", 1, [&host](jsi::Runtime& rt, const jsi::Value&, Args a, size_t n) -> jsi::Value {
      if (n < 1 || !a[0].isString()) throw jsi::JSError(rt, "zero-native: __zn_store_read(key)");
      const FlowStore::ReadResult r = host.storeRead(a[0].getString(rt).utf8(rt));
      if (r.status == FlowStore::ReadStatus::Missing) return jsi::Value::null();
      if (r.status == FlowStore::ReadStatus::Broken) return jsi::Value(false);
      return jsi::String::createFromUtf8(rt, r.payload);
    });

    define("__zn_store_list", 0, [&host](jsi::Runtime& rt, const jsi::Value&, Args, size_t) -> jsi::Value {
      const std::vector<std::string> keys = host.storeList();
      jsi::Array out(rt, keys.size());
      for (size_t i = 0; i < keys.size(); i++) out.setValueAtIndex(rt, i, jsi::String::createFromUtf8(rt, keys[i]));
      return out;
    });

    define("__zn_store_remove", 1, [&host](jsi::Runtime& rt, const jsi::Value&, Args a, size_t n) -> jsi::Value {
      if (n < 1 || !a[0].isString()) throw jsi::JSError(rt, "zero-native: __zn_store_remove(key)");
      return jsi::Value(host.storeRemove(a[0].getString(rt).utf8(rt)));
    });

    // App storage (storage.h). The store id is checked here: it becomes a file name.
    auto storeId = [](jsi::Runtime& rt, const jsi::Value* a, size_t n) {
      std::string id = stringArg(rt, a, n, 0, "a storage id");
      if (!Storage::validId(id)) {
        throw jsi::JSError(rt, "zero-native: storage id \"" + id + "\" must be 1-64 characters from A-Z a-z 0-9 . _ -");
      }
      return id;
    };

    define("__zn_kv_set", 5, [&host, storeId](jsi::Runtime& rt, const jsi::Value&, Args a, size_t n) -> jsi::Value {
      const std::string id = storeId(rt, a, n);
      const std::string key = stringArg(rt, a, n, 1, "a storage key");
      if (n < 3) throw jsi::JSError(rt, "zero-native: __zn_kv_set(id, key, value)");
      const std::vector<uint8_t> tagged = toStored(rt, a, n, 2);
      return jsi::Value(host.storageSet(id, key, tagged));
    });

    define("__zn_kv_get", 2, [&host, storeId](jsi::Runtime& rt, const jsi::Value&, Args a, size_t n) -> jsi::Value {
      const std::string id = storeId(rt, a, n);
      const std::string key = stringArg(rt, a, n, 1, "a storage key");
      const std::optional<std::vector<uint8_t>> blob = host.storageGet(id, key);
      if (!blob) return jsi::Value::undefined();
      return fromStored(rt, *blob, id, key);
    });

    define("__zn_kv_has", 2, [&host, storeId](jsi::Runtime& rt, const jsi::Value&, Args a, size_t n) -> jsi::Value {
      const std::string id = storeId(rt, a, n);
      return jsi::Value(host.storageHas(id, stringArg(rt, a, n, 1, "a storage key")));
    });

    define("__zn_kv_delete", 2, [&host, storeId](jsi::Runtime& rt, const jsi::Value&, Args a, size_t n) -> jsi::Value {
      const std::string id = storeId(rt, a, n);
      return jsi::Value(host.storageRemove(id, stringArg(rt, a, n, 1, "a storage key")));
    });

    define("__zn_kv_keys", 1, [&host, storeId](jsi::Runtime& rt, const jsi::Value&, Args a, size_t n) -> jsi::Value {
      const std::vector<std::string> keys = host.storageKeys(storeId(rt, a, n));
      jsi::Array out(rt, keys.size());
      for (size_t i = 0; i < keys.size(); i++) out.setValueAtIndex(rt, i, jsi::String::createFromUtf8(rt, keys[i]));
      return out;
    });

    define("__zn_kv_clear", 1, [&host, storeId](jsi::Runtime& rt, const jsi::Value&, Args a, size_t n) -> jsi::Value {
      host.storageClear(storeId(rt, a, n));
      return jsi::Value::undefined();
    });

    define("__zn_kv_flush", 1, [&host, storeId](jsi::Runtime& rt, const jsi::Value&, Args a, size_t n) -> jsi::Value {
      host.storageFlush(storeId(rt, a, n));
      return jsi::Value::undefined();
    });

    define("__zn_cancel", 1, [&host](jsi::Runtime& rt, const jsi::Value&, Args a, size_t n) -> jsi::Value {
      host.cancelCall(u32Arg(rt, a, n, 0));
      return jsi::Value::undefined();
    });

    define("__zn_log", 2, [&host](jsi::Runtime& rt, const jsi::Value&, Args a, size_t n) -> jsi::Value {
      const int level = (n > 0 && a[0].isNumber()) ? static_cast<int>(a[0].getNumber()) : 1;
      const std::string msg = n > 1 ? a[1].toString(rt).utf8(rt) : std::string();
      host.log(level, msg);
      return jsi::Value::undefined();
    });

    define("__zn_error", 3, [&host](jsi::Runtime& rt, const jsi::Value&, Args a, size_t n) -> jsi::Value {
      const std::string where = n > 0 ? a[0].toString(rt).utf8(rt) : std::string();
      const std::string details = n > 1 ? a[1].toString(rt).utf8(rt) : std::string();
      // The kind is optional: a core from before step 3.9 sends two arguments.
      const std::string kind = n > 2 && a[2].isString() ? a[2].asString(rt).utf8(rt) : std::string("handler");
      host.jsError(kind, where, details);
      return jsi::Value::undefined();
    });

    define("__zn_now", 0, [&host](jsi::Runtime&, const jsi::Value&, Args, size_t) -> jsi::Value {
      return jsi::Value(host.nowMs());
    });
  }

  HostApi& host_;
  std::unique_ptr<facebook::hermes::HermesRuntime> runtime_;
  // One entry into JS taking this long is logged as slow (step 3.9): far below the time limit, so it shows in
  // development long before users would wait on it.
  static constexpr int64_t kSlowEntryMs = 200;
  // Time limit (setTimeLimit). depth_ is JS-thread only; the rest is shared with the watchdog thread.
  int depth_ = 0;
  std::atomic<uint32_t> limitMs_{0};
  std::atomic<int64_t> entryStart_{0};  // steadyMs() when the current entry began; 0 = not in JS
  std::atomic<bool> timedOut_{false};
  std::mutex watchMutex_;
  std::condition_variable watchWake_;
  bool stopping_ = false;  // guarded by watchMutex_
  std::thread watchdog_;
};

}  // namespace

std::unique_ptr<Engine> createHermesEngine(HostApi& host) { return std::make_unique<HermesEngine>(host); }

uint32_t hermesBytecodeVersion() { return rootApi()->getBytecodeVersion(); }

}  // namespace zn
