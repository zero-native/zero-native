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
//   __zn_call(module, method, argsJson, callbackId)   (result: app event 7, see runtime.h Platform::callNative)
//   __zn_cancel(callbackId)
//   __zn_store_write(key, json) / __zn_store_read(key) / __zn_store_list() / __zn_store_remove(key)   (FlowStore)
//   __zn_setTimer(delayMs, repeat) -> handle
//   __zn_clearTimer(handle)
//   __zn_log(level, message)
//   __zn_now() -> ms
// Called by native (defined by the JS runtime): __zn_onEvent(instance, eventId, payload), __zn_onTimer(handle).
#include "zn/engine.h"

#include <hermes/hermes.h>
#include <jsi/jsi.h>

#include <cstdint>
#include <exception>
#include <string>
#include <utility>

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

  EvalResult evalBytecode(const Bytes& bytecode, std::string_view url) override {
    if (bytecode.data == nullptr || bytecode.size == 0) {
      return {false, "empty bytecode: " + std::string(url)};
    }
    if (!rootApi()->isHermesBytecode(bytecode.data, bytecode.size)) {
      return {false, "not Hermes bytecode (wrong file or wrong hermesc version?): " + std::string(url)};
    }
    return guard([&] {
      auto buffer = std::make_shared<BytesBuffer>(bytecode);
      jsi::Value result = runtime_->evaluateJavaScript(buffer, std::string(url));
      runtime_->drainMicrotasks();
      return describe(result);
    });
  }

  EvalResult callGlobal(std::string_view name, std::span<const Value> args) override {
    return guard([&] {
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

  void drainMicrotasks() override { runtime_->drainMicrotasks(); }

 private:
  template <typename F>
  EvalResult guard(F&& body) {
    try {
      return {true, body()};
    } catch (const jsi::JSError& e) {
      return {false, e.getMessage() + "\n" + e.getStack()};
    } catch (const std::exception& e) {
      return {false, e.what()};
    }
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
      host.call(module, method, args, u32Arg(rt, a, n, 3));
      return jsi::Value::undefined();
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

    define("__zn_error", 2, [&host](jsi::Runtime& rt, const jsi::Value&, Args a, size_t n) -> jsi::Value {
      const std::string where = n > 0 ? a[0].toString(rt).utf8(rt) : std::string();
      const std::string details = n > 1 ? a[1].toString(rt).utf8(rt) : std::string();
      host.jsError(where, details);
      return jsi::Value::undefined();
    });

    define("__zn_now", 0, [&host](jsi::Runtime&, const jsi::Value&, Args, size_t) -> jsi::Value {
      return jsi::Value(host.nowMs());
    });
  }

  HostApi& host_;
  std::unique_ptr<facebook::hermes::HermesRuntime> runtime_;
};

}  // namespace

std::unique_ptr<Engine> createHermesEngine(HostApi& host) { return std::make_unique<HermesEngine>(host); }

}  // namespace zn
