// Engine tests: the shared core with the real Hermes engine, run on a computer (core/tests/apple/CMakeLists.txt).
// They check that a bundle built for Android runs unchanged on another platform's Hermes (iOS step i.1a,
// docs/milestones.md): the same hermesc bytecode, the same host functions, the same batch out.
//
//   zn_engine_tests <path to main.hbc>
//
// One thread plays both the JS thread and the UI thread: every call into the runtime is followed by takeBatch().
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <memory>
#include <string>
#include <vector>

#include <unistd.h>

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

struct TestPlatform final : zn::Platform {
  std::vector<std::string> logs;
  std::vector<std::string> errors;
  std::vector<std::pair<uint32_t, double>> timers;
  std::vector<std::string> calls;
  int applyRequests = 0;
  std::string dir;

  void scheduleTimer(uint32_t handle, double delayMs) override { timers.emplace_back(handle, delayMs); }
  void requestApply() override { applyRequests++; }
  void log(int level, std::string_view message) override {
    logs.emplace_back(message);
    if (level >= 2) std::printf("  [js %s] %.*s\n", level >= 3 ? "error" : "warn", int(message.size()), message.data());
  }
  void callNative(std::string_view module, std::string_view method, std::string_view, uint32_t,
                  std::optional<std::span<const uint8_t>>) override {
    calls.emplace_back(std::string(module) + "." + std::string(method));
  }
  void cancelNative(uint32_t) override {}
  std::string flowStoreDir() override { return dir; }
  std::string storageDir() override { return dir; }
  double nowMs() override { return 0; }
  void jsError(std::string_view kind, std::string_view where, std::string_view details) override {
    errors.emplace_back(std::string(where) + " [" + std::string(kind) + "]: " + std::string(details));
    std::printf("  [jsError] %s\n", errors.back().c_str());
  }
};

std::vector<uint8_t> readFile(const char* path) {
  std::ifstream in(path, std::ios::binary);
  return std::vector<uint8_t>(std::istreambuf_iterator<char>(in), {});
}

void testSampleBundle(const char* hbcPath) {
  std::printf("the Android sample's main.hbc runs on this Hermes and builds its first screen\n");
  const std::vector<uint8_t> file = readFile(hbcPath);
  CHECK(!file.empty());
  if (file.empty()) return;

  TestPlatform platform;
  const char* base = std::getenv("ZN_TEST_DIR");
  platform.dir = std::string(base && *base ? base : "/tmp") + "/zn-engine-test";
  std::error_code ec;
  std::filesystem::create_directories(platform.dir, ec);

  zn::Runtime runtime(platform, zn::createHermesEngine);
  auto owner = std::make_shared<std::vector<uint8_t>>(file);
  zn::Bytes bytes{owner->data(), owner->size(), owner};
  const zn::EvalResult r = runtime.evalBytecode(bytes, "main.hbc");
  if (!r.ok) std::printf("  eval failed: %s\n", r.value.c_str());
  CHECK(r.ok);
  if (!r.ok) return;
  runtime.takeBatch();

  // START (instance 0, event 1): the first screen, as ZnNav.startWith sends it. Native entry ids have the top bit set.
  const uint32_t entry = 0x80000001u;
  const std::string start = "[{\"entry\":" + std::to_string(entry) + ",\"route\":0,\"params\":{}}]";
  runtime.dispatchEvent(0, 1, zn::Value::string(start));
  const std::vector<uint8_t> batch = runtime.takeBatch();
  std::printf("  after START: batch of %zu bytes, %d apply request(s), %zu timer(s), %zu native call(s)\n", batch.size(),
              platform.applyRequests, platform.timers.size(), platform.calls.size());
  for (const auto& c : platform.calls) std::printf("    call %s\n", c.c_str());
  CHECK(!batch.empty());
  CHECK(platform.applyRequests > 0);
  CHECK(platform.errors.empty());
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::printf("usage: %s <path to main.hbc>\n", argv[0]);
    return 2;
  }
  testSampleBundle(argv[1]);
  std::printf("\n%d checks, %d failed\n%s\n", g_checks, g_failed, g_failed ? "FAILED" : "OK");
  return g_failed ? 1 : 0;
}
