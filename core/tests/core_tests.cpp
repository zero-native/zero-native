// Core unit tests. They run on a phone (no host C++ toolchain needed): tools/run-core-tests.ps1 builds this with
// the NDK, pushes it to the device and runs it. Exit code 0 = all passed.
// They use a fake engine and a fake platform, so they test the runtime rules without Hermes.
#include <cstdio>
#include <cstring>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "zn/batch.h"
#include "zn/runtime.h"

namespace {

int g_failed = 0;
int g_checks = 0;

#define CHECK(cond)                                                              \
  do {                                                                           \
    g_checks++;                                                                  \
    if (!(cond)) {                                                               \
      g_failed++;                                                                \
      std::printf("  FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);              \
    }                                                                            \
  } while (0)

// ---- Fakes -------------------------------------------------------------------------------------------------------

struct FakePlatform : zn::Platform {
  std::vector<std::pair<uint32_t, double>> scheduled;  // (handle, delay)
  int applyRequests = 0;
  std::vector<std::string> logs;
  void scheduleTimer(uint32_t handle, double delayMs) override { scheduled.emplace_back(handle, delayMs); }
  void requestApply() override { applyRequests++; }
  void log(int, std::string_view m) override { logs.emplace_back(m); }
  double nowMs() override { return 0; }
};

// Lets a test decide what "JS" does when an event or timer arrives.
struct FakeEngine : zn::Engine {
  zn::HostApi& host;
  std::vector<std::string> calls;
  std::function<void(zn::HostApi&, std::string_view, std::span<const zn::Value>)> onCall;
  explicit FakeEngine(zn::HostApi& h) : host(h) {}
  zn::EvalResult evalBytecode(const zn::Bytes&, std::string_view) override { return {true, "ok"}; }
  zn::EvalResult callGlobal(std::string_view name, std::span<const zn::Value> args) override {
    calls.emplace_back(name);
    if (onCall) onCall(host, name, args);
    return {true, "undefined"};
  }
  void drainMicrotasks() override {}
};

struct Harness {
  FakePlatform platform;
  FakeEngine* engine = nullptr;
  zn::Runtime runtime{platform, [this](zn::HostApi& h) {
                        auto e = std::make_unique<FakeEngine>(h);
                        engine = e.get();
                        return e;
                      }};
};

// ---- Byte reading helpers ----------------------------------------------------------------------------------------

struct Reader {
  const std::vector<uint8_t>& b;
  size_t pos = 0;
  template <typename T>
  T get() {
    T v;
    std::memcpy(&v, b.data() + pos, sizeof v);
    pos += sizeof v;
    return v;
  }
};

// ---- Tests -------------------------------------------------------------------------------------------------------

void testBatchEncoding() {
  std::printf("batch encoding\n");
  zn::Batch batch;
  batch.patch(7, 2, zn::Value::number(42));
  batch.patch(7, 3, zn::Value::string("hi"));
  batch.remove(9);
  const std::vector<uint8_t> bytes = batch.encode();

  Reader r{bytes};
  CHECK(r.get<uint32_t>() == zn::kBatchMagic);
  CHECK(r.get<uint32_t>() == 3);
  CHECK(r.get<uint8_t>() == 1);  // PATCH
  CHECK(r.get<uint32_t>() == 7);
  CHECK(r.get<uint16_t>() == 2);
  CHECK(r.get<uint8_t>() == 3);  // number
  CHECK(r.get<double>() == 42.0);
  CHECK(r.get<uint8_t>() == 1);  // PATCH
  CHECK(r.get<uint32_t>() == 7);
  CHECK(r.get<uint16_t>() == 3);
  CHECK(r.get<uint8_t>() == 4);  // string
  CHECK(r.get<uint32_t>() == 2);
  CHECK(bytes[r.pos] == 'h' && bytes[r.pos + 1] == 'i');
  r.pos += 2;
  CHECK(r.get<uint8_t>() == 3);  // REMOVE
  CHECK(r.get<uint32_t>() == 9);
  CHECK(r.pos == bytes.size());
}

void testPatchCoalescing() {
  std::printf("patch coalescing\n");
  zn::Batch batch;
  batch.patch(1, 0, zn::Value::string("a"));
  batch.mount(5, 1, 0, 2, 0, {zn::Value::boolean(true)});
  batch.patch(1, 0, zn::Value::string("b"));  // replaces the first patch, keeps its position
  CHECK(batch.size() == 2);
  CHECK(batch.ops()[0].code == zn::OpCode::Patch);
  CHECK(batch.ops()[0].value == zn::Value::string("b"));
  CHECK(batch.ops()[1].code == zn::OpCode::Mount);
  CHECK(batch.ops()[1].values.size() == 1);
}

void testNav() {
  std::printf("nav ops: encoding, order kept, never merged\n");
  zn::Batch batch;
  batch.nav(zn::NavKind::Push, 12, 1, zn::Value::string("{\"merchantId\":\"m1\"}"));
  batch.patch(12, 0, zn::Value::number(5));
  batch.nav(zn::NavKind::Remove, 12, 0, zn::Value::null());
  batch.nav(zn::NavKind::BackAnswered, 0, 0, zn::Value::null());
  CHECK(batch.size() == 4);
  const std::vector<uint8_t> bytes = batch.encode();

  Reader r{bytes};
  CHECK(r.get<uint32_t>() == zn::kBatchMagic);
  CHECK(r.get<uint32_t>() == 4);
  CHECK(r.get<uint8_t>() == 5);  // NAV
  CHECK(r.get<uint8_t>() == 1);  // PUSH
  CHECK(r.get<uint32_t>() == 12);
  CHECK(r.get<uint16_t>() == 1);
  CHECK(r.get<uint8_t>() == 4);  // params: string
  const uint32_t len = r.get<uint32_t>();
  CHECK(len == 19);
  r.pos += len;
  CHECK(r.get<uint8_t>() == 1);  // PATCH
  r.pos += 4 + 2 + 1 + 8;
  CHECK(r.get<uint8_t>() == 5);  // NAV
  CHECK(r.get<uint8_t>() == 2);  // REMOVE
  CHECK(r.get<uint32_t>() == 12);
  CHECK(r.get<uint16_t>() == 0);
  CHECK(r.get<uint8_t>() == 0);  // params: null
  CHECK(r.get<uint8_t>() == 5);
  CHECK(r.get<uint8_t>() == 5);  // BACK_ANSWERED
  r.pos += 4 + 2 + 1;
  CHECK(r.pos == bytes.size());

  // Through the runtime: unknown kinds are dropped with an error log.
  Harness h;
  h.engine->onCall = [](zn::HostApi& host, std::string_view, std::span<const zn::Value>) {
    host.nav(1, 3, 2, zn::Value::null());
    host.nav(9, 3, 2, zn::Value::null());
  };
  h.runtime.dispatchEvent(0, 2, zn::Value::null());
  std::vector<uint8_t> out = h.runtime.takeBatch();
  Reader r2{out};
  r2.pos += 4;
  CHECK(r2.get<uint32_t>() == 1);
  CHECK(!h.platform.logs.empty() && h.platform.logs.back().find("unknown kind 9") != std::string::npos);
}

void testListOps() {
  std::printf("list ops: set, splice, row\n");
  zn::Batch batch;
  batch.listSet(7, 3, {zn::Value::string("a"), zn::Value::string("b")}, {4, 5});
  batch.listSplice(7, 3, 0, 1, {zn::Value::string("c")}, {4});
  batch.listRow(7, 3, zn::Value::string("c"), 12);
  const std::vector<uint8_t> bytes = batch.encode();
  Reader r{bytes};
  CHECK(r.get<uint32_t>() == zn::kBatchMagic);
  CHECK(r.get<uint32_t>() == 3);
  CHECK(r.get<uint8_t>() == 6);  // LIST_SET
  CHECK(r.get<uint32_t>() == 7);
  CHECK(r.get<uint16_t>() == 3);
  CHECK(r.get<uint32_t>() == 2);
  CHECK(r.get<uint8_t>() == 4 && r.get<uint32_t>() == 1);  // "a"
  r.pos += 1;
  CHECK(r.get<uint16_t>() == 4);
  r.pos += 1 + 4 + 1;  // "b"
  CHECK(r.get<uint16_t>() == 5);
  CHECK(r.get<uint8_t>() == 7);  // LIST_SPLICE
  r.pos += 4 + 2;
  CHECK(r.get<uint32_t>() == 0);  // index
  CHECK(r.get<uint32_t>() == 1);  // removeCount
  CHECK(r.get<uint32_t>() == 1);  // insertCount
  r.pos += 1 + 4 + 1 + 2;         // "c", type
  CHECK(r.get<uint8_t>() == 8);  // LIST_ROW
  r.pos += 4 + 2 + 1 + 4 + 1;    // instance, node, "c"
  CHECK(r.get<uint32_t>() == 12);
  CHECK(r.pos == bytes.size());
}

void testTickAndApply() {
  std::printf("tick → one apply request, coalescing until taken\n");
  Harness h;
  h.engine->onCall = [](zn::HostApi& host, std::string_view, std::span<const zn::Value> args) {
    host.patch(1, 0, args.size() > 2 ? args[2] : zn::Value::null());
  };

  h.runtime.dispatchEvent(1, 1, zn::Value::number(1));
  CHECK(h.platform.applyRequests == 1);
  h.runtime.dispatchEvent(1, 1, zn::Value::number(2));  // UI hasn't taken yet: merged, no second request
  CHECK(h.platform.applyRequests == 1);

  std::vector<uint8_t> bytes = h.runtime.takeBatch();
  Reader r{bytes};
  CHECK(r.get<uint32_t>() == zn::kBatchMagic);
  CHECK(r.get<uint32_t>() == 1);  // two ticks, same slot → one patch
  r.pos += 1 + 4 + 2 + 1;
  CHECK(r.get<double>() == 2.0);  // the latest value

  CHECK(h.runtime.takeBatch().empty());
  h.runtime.dispatchEvent(1, 1, zn::Value::number(3));
  CHECK(h.platform.applyRequests == 2);  // after a take, the next tick asks again
}

void testNoOpsNoRequest() {
  std::printf("a tick without ops asks for nothing\n");
  Harness h;
  h.runtime.dispatchEvent(1, 1, zn::Value::null());
  CHECK(h.platform.applyRequests == 0);
  CHECK(h.runtime.takeBatch().empty());
}

void testTimers() {
  std::printf("timers: fixed handles, clear always wins\n");
  Harness h;
  zn::HostApi& host = h.engine->host;

  // One-shot timer: fires once, then is gone.
  const uint32_t once = host.setTimer(50, false);
  CHECK(h.platform.scheduled.size() == 1);
  CHECK(h.platform.scheduled[0].first == once);
  h.runtime.fireTimer(once);
  CHECK(h.engine->calls.size() == 1);
  CHECK(h.runtime.activeTimers() == 0);
  h.runtime.fireTimer(once);  // a stray second fire does nothing
  CHECK(h.engine->calls.size() == 1);

  // Repeating timer: same handle every time, rescheduled before JS runs.
  const uint32_t every = host.setTimer(150, true);
  h.runtime.fireTimer(every);
  h.runtime.fireTimer(every);
  CHECK(h.engine->calls.size() == 3);
  CHECK(h.platform.scheduled.back().first == every);
  CHECK(h.runtime.activeTimers() == 1);

  // Cleared while a fire is already queued: the queued fire must not reach JS (the v0 "zombie timer" bug).
  host.clearTimer(every);
  h.runtime.fireTimer(every);
  CHECK(h.engine->calls.size() == 3);
  CHECK(h.runtime.activeTimers() == 0);

  // clearInterval from inside its own callback.
  const uint32_t self = host.setTimer(10, true);
  h.engine->onCall = [self](zn::HostApi& hst, std::string_view, std::span<const zn::Value>) { hst.clearTimer(self); };
  h.runtime.fireTimer(self);
  h.runtime.fireTimer(self);
  CHECK(h.engine->calls.size() == 4);

  // A repeating timer never gets a 0 ms interval.
  const uint32_t fast = host.setTimer(0, true);
  CHECK(h.platform.scheduled.back().first == fast);
  CHECK(h.platform.scheduled.back().second >= 1);
}

}  // namespace

int main() {
  testBatchEncoding();
  testPatchCoalescing();
  testNav();
  testListOps();
  testTickAndApply();
  testNoOpsNoRequest();
  testTimers();
  std::printf("\n%d checks, %d failed\n", g_checks, g_failed);
  std::printf(g_failed == 0 ? "ALL PASSED\n" : "FAILED\n");
  return g_failed == 0 ? 0 : 1;
}
