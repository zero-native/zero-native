// Core unit tests. They run on a phone (no host C++ toolchain needed): tools/run-core-tests.ps1 builds this with
// the NDK, pushes it to the device and runs it. Exit code 0 = all passed.
// They use a fake engine and a fake platform, so they test the runtime rules without Hermes.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include <fcntl.h>
#include <signal.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#include <algorithm>
#include <random>

#include "zn/batch.h"
#include "zn/flowstore.h"
#include "zn/runtime.h"
#include "zn/storage.h"
#include "zn/utf8.h"

namespace {

int g_failed = 0;
int g_checks = 0;

// Base folder for test files: $ZN_TEST_DIR if set (the Mac, the iOS simulator), else the phone's /data/local/tmp
// (tools/run-core-tests.ps1).
std::string testPath(const char* name) {
  const char* base = std::getenv("ZN_TEST_DIR");
  return std::string(base && *base ? base : "/data/local/tmp") + "/" + name;
}

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
  std::vector<std::string> calls;
  void callNative(std::string_view module, std::string_view method, std::string_view args, uint32_t id,
                  std::optional<std::span<const uint8_t>> bytes) override {
    std::string c = std::string(module) + "." + std::string(method) + "(" + std::string(args) + ")#" + std::to_string(id);
    if (bytes) c += " +" + std::string(reinterpret_cast<const char*>(bytes->data()), bytes->size());
    calls.push_back(c);
  }
  std::vector<uint32_t> cancelled;
  void cancelNative(uint32_t id) override { cancelled.push_back(id); }
  std::string flowStoreDir() override { return testPath("zn-flowstore-test"); }
  std::string storageDir() override { return testPath("zn-storage-test"); }
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
  std::vector<std::vector<uint8_t>> buffers;  // ArrayBuffers handed to callGlobalBytes
  zn::EvalResult callGlobalBytes(std::string_view name, std::span<const zn::Value> args,
                                 std::vector<uint8_t> bytes) override {
    buffers.push_back(std::move(bytes));
    return callGlobal(name, args);
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
    host.nav(12, 3, 2, zn::Value::null());  // 9 RESTORE (host API 4), 10 BACK_WANTED (bottom tabs), 11 LAYER
  };
  h.runtime.dispatchEvent(0, 2, zn::Value::null());
  std::vector<uint8_t> out = h.runtime.takeBatch();
  Reader r2{out};
  r2.pos += 4;
  CHECK(r2.get<uint32_t>() == 1);
  CHECK(!h.platform.logs.empty() && h.platform.logs.back().find("unknown kind 12") != std::string::npos);
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

void testNativeCall() {
  std::printf("native calls go to the platform, not into the batch\n");
  Harness h;
  h.engine->onCall = [](zn::HostApi& host, std::string_view, std::span<const zn::Value>) {
    host.call("os", "upiApps", "{}", 4, std::nullopt);
    host.cancelCall(4);
    const uint8_t body[] = {'h', 'i'};
    host.call("Fetch", "send", "{}", 5, std::span<const uint8_t>(body, 2));
    host.call("Fetch", "send", "{}", 6, std::span<const uint8_t>());  // empty body is not "no body"
  };
  h.runtime.dispatchEvent(0, 1, zn::Value::null());
  CHECK(h.platform.calls.size() == 3 && h.platform.calls[0] == "os.upiApps({})#4");
  CHECK(h.platform.calls[1] == "Fetch.send({})#5 +hi");
  CHECK(h.platform.calls[2] == "Fetch.send({})#6 +");
  CHECK(h.platform.cancelled.size() == 1 && h.platform.cancelled[0] == 4);
  CHECK(h.platform.applyRequests == 0);  // a call is not a UI change

  // Binary answers reach JS as one buffer, through the same event entry point and tick.
  h.engine->onCall = [](zn::HostApi& host, std::string_view, std::span<const zn::Value>) { host.patch(1, 1, zn::Value::number(1)); };
  h.runtime.dispatchBytes(0, 9, {1, 2, 3});
  CHECK(h.engine->buffers.size() == 1 && h.engine->buffers[0] == std::vector<uint8_t>({1, 2, 3}));
  CHECK(h.engine->calls.back() == "__zn_onEvent");
  CHECK(h.platform.applyRequests == 1);  // the tick ended as usual
}

// ---- UTF-8 (TextDecoder, fetch text()) ------------------------------------------------------------------------------

std::string clean(const std::string& s) {
  return zn::utf8::sanitize(reinterpret_cast<const uint8_t*>(s.data()), s.size());
}
bool isValid(const std::string& s) { return zn::utf8::valid(reinterpret_cast<const uint8_t*>(s.data()), s.size()); }

void testUtf8() {
  std::printf("utf-8 checks match the web decoder\n");
  const std::string fffd = "\xEF\xBF\xBD";
  CHECK(isValid(""));
  CHECK(isValid("plain ascii"));
  CHECK(isValid("\xE0\xA4\xA8\xE0\xA4\xAE\xE0\xA4\xB8\xE0\xA5\x8D\xE0\xA4\xA4\xE0\xA5\x87"));  // Hindi "namaste"
  CHECK(isValid("\xF0\x9F\x98\x80"));      // an emoji (4 bytes)
  CHECK(isValid("\xF4\x8F\xBF\xBF"));      // U+10FFFF
  CHECK(!isValid("\xF4\x90\x80\x80"));     // above U+10FFFF
  CHECK(!isValid("\xED\xA0\x80"));         // a surrogate (CESU-8)
  CHECK(!isValid("\xC0\xAF"));             // overlong "/"
  CHECK(!isValid("\xE0\x80\xAF"));         // overlong
  CHECK(!isValid("\x80"));                 // lone continuation byte
  CHECK(!isValid("\xE2\x82"));             // cut short at the end

  CHECK(clean("a\x80" "b") == "a" + fffd + "b");          // split: "\x80b" would be one hex escape
  CHECK(clean("\xE2\x82") == fffd);                       // one U+FFFD for a cut-off sequence
  CHECK(clean("\xE2\x82" "A") == fffd + "A");             // the breaking byte is read again
  CHECK(clean("\xED\xA0\x80") == fffd + fffd + fffd);     // web: 3 replacement characters
  CHECK(clean("\xF0\x9F\x98") == fffd);
  CHECK(clean("\xFF\xFE") == fffd + fffd);
  CHECK(clean("ok \xF0\x9F\x98\x80") == "ok \xF0\x9F\x98\x80");  // valid text is unchanged
}

// ---- App storage (MMKV) ------------------------------------------------------------------------------------------

void testStorage() {
  std::printf("storage: tagged values in MMKV, keys, delete, clear, separate stores\n");
  const std::string dirPath = testPath("zn-storage-test");
  const char* dir = dirPath.c_str();
  mkdir(dir, 0700);
  std::vector<std::string> logs;
  zn::Storage s(dir, [&](int, std::string_view m) { logs.emplace_back(m); });
  s.clear("test.a");
  s.clear("test.b");

  const std::vector<uint8_t> hello = {1, 'h', 'i'};
  const std::vector<uint8_t> num = {2, 0, 0, 0, 0, 0, 0, 0xF8, 0x3F};  // 1.5
  CHECK(s.set("test.a", "greeting", hello));
  CHECK(s.set("test.a", "n", num));
  CHECK(s.set("test.b", "greeting", std::vector<uint8_t>{3, 1}));
  CHECK(s.get("test.a", "greeting") == hello);
  CHECK(s.get("test.a", "n") == num);
  CHECK(s.get("test.b", "greeting") == std::vector<uint8_t>({3, 1}));  // stores don't share keys
  CHECK(!s.get("test.a", "missing").has_value());
  CHECK(s.has("test.a", "n") && !s.has("test.a", "missing"));

  CHECK(s.set("test.a", "greeting", std::vector<uint8_t>{1, 'y', 'o'}));  // overwrite
  CHECK(s.get("test.a", "greeting") == std::vector<uint8_t>({1, 'y', 'o'}));
  std::vector<std::string> keys = s.keys("test.a");
  std::sort(keys.begin(), keys.end());
  CHECK(keys == std::vector<std::string>({"greeting", "n"}));

  s.remove("test.a", "n");
  CHECK(!s.has("test.a", "n"));
  s.clear("test.a");
  CHECK(s.keys("test.a").empty());
  CHECK(s.keys("test.b").size() == 1);

  // A big value and many keys (MMKV grows its file).
  std::vector<uint8_t> big(200000, 7);
  big[0] = 4;
  CHECK(s.set("test.b", "big", big));
  for (int i = 0; i < 2000; i++) s.set("test.b", "k" + std::to_string(i), std::vector<uint8_t>{3, 1});
  CHECK(s.get("test.b", "big") == big);
  CHECK(s.keys("test.b").size() == 2002);
  s.clear("test.b");

  CHECK(zn::Storage::validId("zn.default") && zn::Storage::validId("user_42-settings"));
  CHECK(!zn::Storage::validId("") && !zn::Storage::validId("../x") && !zn::Storage::validId("a/b"));
  CHECK(!zn::Storage::validId(std::string(65, 'a')));
}

// A child process writes to a store nonstop and is killed at a random moment; the parent then reads every value.
// Each round uses a new store id: in single-process mode MMKV never re-reads a file it already has open.
void testStorageKill() {
  std::printf("storage: killed mid-write 100 times, every value still reads back whole\n");
  const std::string dirPath = testPath("zn-storage-kill");
  const char* dir = dirPath.c_str();
  mkdir(dir, 0700);
  std::mt19937 rng(7);
  int rounds = 0, good = 0, recovered = 0;
  for (int round = 0; round < 100; round++) {
    const std::string id = "kill.r" + std::to_string(round);
    pid_t child = fork();
    if (child == 0) {
      zn::Storage s(dir, nullptr);
      s.clear(id);
      for (uint32_t n = 1;; n++) {
        std::vector<uint8_t> count(9, 0);
        count[0] = 2;
        const double d = n;
        std::memcpy(count.data() + 1, &d, 8);
        s.set(id, "count", count);
        // A string ending in its own number, of changing size, so a torn value would show.
        const std::string text = "v" + std::to_string(n) + ":" + std::string(20 + (n * 131) % 3000, 'a' + n % 26) +
                                 ":" + std::to_string(n);
        std::vector<uint8_t> blob(1, 1);
        blob.insert(blob.end(), text.begin(), text.end());
        s.set(id, "k" + std::to_string(n % 40), blob);
      }
    }
    usleep(2000 + rng() % 30000);
    kill(child, SIGKILL);
    waitpid(child, nullptr, 0);

    std::vector<std::string> logs;
    zn::Storage s(dir, [&](int, std::string_view m) { logs.emplace_back(m); });
    rounds++;
    bool ok = true;
    double count = 0;
    if (auto c = s.get(id, "count")) {
      ok = ok && c->size() == 9 && (*c)[0] == 2;
      if (ok) std::memcpy(&count, c->data() + 1, 8);
    }
    for (const std::string& key : s.keys(id)) {
      if (key == "count") continue;
      auto v = s.get(id, key);
      if (!v || v->empty() || (*v)[0] != 1) {
        ok = false;
        continue;
      }
      const std::string text(v->begin() + 1, v->end());
      const std::string head = text.substr(1, text.find(':') - 1);
      const std::string tail = text.substr(text.rfind(':') + 1);
      // Whole, and never newer than the counter written just before it.
      ok = ok && head == tail && std::stod(head) <= count;
    }
    for (const std::string& l : logs) {
      if (l.find("dropped") != std::string::npos) recovered++;
    }
    if (ok) {
      good++;
    } else {
      std::printf("  round %d: count=%.0f keys=%zu\n", round, count, s.keys(id).size());
      for (const std::string& key : s.keys(id)) {
        auto v = s.get(id, key);
        std::string shown = v ? std::string(v->begin(), v->begin() + std::min<size_t>(v->size(), 24)) : "(none)";
        for (char& ch : shown) {
          if (ch < 32) ch = '?';
        }
        std::printf("    %s size=%zu tag=%d %s\n", key.c_str(), v ? v->size() : 0, v && !v->empty() ? (*v)[0] : -1,
                    shown.c_str());
      }
      for (const std::string& l : logs) std::printf("    log: %s\n", l.c_str());
    }
    s.clear(id);
  }
  std::printf("  %d / %d rounds read back whole (MMKV found a damaged file and dropped it in %d)\n", good, rounds, recovered);
  CHECK(good == rounds);
}

// ---- FlowStore (ARCHITECTURE §13.2) --------------------------------------------------------------------------------

const std::string kFsDirPath = testPath("zn-flowstore-test");
const char* kFsDir = kFsDirPath.c_str();

void freshDir() {
  std::error_code ec;  // std::system is unavailable on iOS
  std::filesystem::remove_all(kFsDir, ec);
  mkdir(kFsDir, 0700);
}

/** Flips one byte at [offset] of a key's file (to fake a torn or damaged slot). */
void damage(const std::string& key, long offset) {
  const std::string p = std::string(kFsDir) + "/" + key + ".znfs";
  int fd = open(p.c_str(), O_RDWR);
  uint8_t b = 0;
  pread(fd, &b, 1, offset);
  b ^= 0xFF;
  pwrite(fd, &b, 1, offset);
  close(fd);
}

void testFlowStoreBasics() {
  std::printf("flowstore: round trip, newest slot wins, list, remove\n");
  freshDir();
  {
    zn::FlowStore fs(kFsDir);
    CHECK(fs.read("checkout").status == zn::FlowStore::ReadStatus::Missing);
    CHECK(fs.write("checkout", R"({"step":"enteringAmount"})"));
    CHECK(fs.write("checkout", R"({"step":"paying","amountPaise":40000})"));
    auto r = fs.read("checkout");
    CHECK(r.status == zn::FlowStore::ReadStatus::Ok && r.payload == R"({"step":"paying","amountPaise":40000})");
    CHECK(fs.write("nav", "[]"));
    auto keys = fs.list();
    CHECK(keys.size() == 2);
    std::string err;
    CHECK(!fs.write("../evil", "x", &err) && !err.empty());
  }
  {
    zn::FlowStore fs(kFsDir);  // a new process would see the same
    CHECK(fs.read("checkout").payload == R"({"step":"paying","amountPaise":40000})");
    CHECK(fs.remove("nav"));
    CHECK(fs.read("nav").status == zn::FlowStore::ReadStatus::Missing);
  }
}

void testFlowStoreDamage() {
  std::printf("flowstore: a damaged newest slot falls back; both damaged = broken\n");
  freshDir();
  {
    zn::FlowStore fs(kFsDir, 4096);
    fs.write("k", "first");   // slot A, seq 1
    fs.write("k", "second");  // slot B, seq 2
  }
  damage("k", 64 + 4096 + 16);  // a payload byte of slot B
  {
    zn::FlowStore fs(kFsDir, 4096);
    auto r = fs.read("k");
    CHECK(r.status == zn::FlowStore::ReadStatus::Ok && r.payload == "first");
    CHECK(fs.write("k", "third"));  // goes into the damaged slot B, which is not current
    CHECK(fs.read("k").payload == "third");
  }
  damage("k", 64 + 16);         // slot A
  damage("k", 64 + 4096 + 16);  // slot B
  {
    zn::FlowStore fs(kFsDir, 4096);
    CHECK(fs.read("k").status == zn::FlowStore::ReadStatus::Broken);
  }
}

void testFlowStoreGrowth() {
  std::printf("flowstore: grows for big payloads; over the ceiling fails and keeps the good state\n");
  freshDir();
  zn::FlowStore fs(kFsDir, 4096);
  CHECK(fs.write("k", "small"));
  const std::string big(100 * 1024, 'x');
  CHECK(fs.write("k", big));
  CHECK(fs.read("k").payload == big);
  std::string err;
  const std::string huge(300 * 1024, 'y');
  CHECK(!fs.write("k", huge, &err) && err.find("limit") != std::string::npos);
  CHECK(fs.read("k").payload == big);
  zn::FlowStore again(kFsDir, 4096);
  CHECK(again.read("k").payload == big);
}

void testFlowStoreThroughRuntime() {
  std::printf("flowstore: reachable from JS through the runtime (host functions)\n");
  freshDir();
  Harness h;
  bool wrote = false;
  zn::FlowStore::ReadResult read;
  h.engine->onCall = [&](zn::HostApi& host, std::string_view, std::span<const zn::Value>) {
    std::string err;
    wrote = host.storeWrite("flow-checkout", R"({"step":"paying"})", &err);
    read = host.storeRead("flow-checkout");
  };
  h.runtime.dispatchEvent(0, 1, zn::Value::null());
  CHECK(wrote && read.status == zn::FlowStore::ReadStatus::Ok && read.payload == R"({"step":"paying"})");
}

void testFlowStoreKill() {
  std::printf("flowstore: killed mid-write 200 times, always reads a complete value\n");
  freshDir();
  std::mt19937 rng(42);
  int ok = 0;
  for (int round = 0; round < 200; round++) {
    pid_t child = fork();
    if (child == 0) {
      zn::FlowStore fs(kFsDir, 8192);
      for (uint32_t n = 0;; n++) {
        // Values of different sizes (some cross a page), each ending in its own number, so a torn value shows.
        std::string v = "v" + std::to_string(n) + ":" + std::string(500 + (n * 997) % 7000, 'a' + n % 26) + ":" +
                        std::to_string(n);
        fs.write("k", v);
      }
    }
    usleep(1000 + rng() % 20000);
    kill(child, SIGKILL);
    waitpid(child, nullptr, 0);
    zn::FlowStore fs(kFsDir, 8192);
    auto r = fs.read("k");
    if (r.status != zn::FlowStore::ReadStatus::Ok) continue;  // killed before the first write finished: allowed once
    const size_t colon = r.payload.find(':');
    const std::string head = r.payload.substr(1, colon - 1);
    const std::string tail = r.payload.substr(r.payload.rfind(':') + 1);
    if (head == tail) ok++;
  }
  std::printf("  %d / 200 rounds read a complete value\n", ok);
  CHECK(ok >= 199);

  // Cost of one write (a typical flow state is under 1 KB).
  zn::FlowStore fs(kFsDir);
  const std::string v(800, 'z');
  timespec a{}, b{};
  clock_gettime(CLOCK_MONOTONIC, &a);
  for (int i = 0; i < 10000; i++) fs.write("speed", v);
  clock_gettime(CLOCK_MONOTONIC, &b);
  const double us = ((b.tv_sec - a.tv_sec) * 1e9 + (b.tv_nsec - a.tv_nsec)) / 1e3 / 10000;
  std::printf("  one 800-byte write: %.2f us (average of 10,000)\n", us);
}

/** True when every byte of the key's file has a disk block behind it (no holes). */
bool fullyReserved(const std::string& key) {
  struct stat st{};
  if (stat((std::string(kFsDir) + "/" + key + ".znfs").c_str(), &st) != 0) return false;
  return static_cast<long long>(st.st_blocks) * 512 >= static_cast<long long>(st.st_size);
}

void testFlowStoreReserve() {
  std::printf("flowstore: files have no holes; a full disk fails cleanly and keeps the good state\n");
  freshDir();
  {
    // A new file and a grown file are fully reserved.
    zn::FlowStore fs(kFsDir, 8192);
    CHECK(fs.write("new", "a"));
    CHECK(fullyReserved("new"));
    CHECK(fs.write("new", std::string(20 * 1024, 'b')));
    CHECK(fullyReserved("new"));
  }
  {
    // A file made the old way (ftruncate: slot B is a hole) is filled on the first write, and keeps its value.
    zn::FlowStore fs(kFsDir, 8192);
    CHECK(fs.write("old", "first"));
  }
  const std::string p = std::string(kFsDir) + "/old.znfs";
  const std::string sparse = p + ".sparse";
  {
    int in = open(p.c_str(), O_RDONLY);
    struct stat st{};
    fstat(in, &st);
    std::vector<uint8_t> head(4096);
    pread(in, head.data(), head.size(), 0);  // header + slot A's start, where "first" is
    close(in);
    int out = open(sparse.c_str(), O_RDWR | O_CREAT | O_TRUNC, 0600);
    CHECK(ftruncate(out, st.st_size) == 0);
    pwrite(out, head.data(), head.size(), 0);
    close(out);
    rename(sparse.c_str(), p.c_str());
  }
  // ext4 / f2fs (Android) leave a hole here. APFS backs small files fully (checked 2026-11-08: a 16 KB file has no
  // hole, a 100 MB one does), so on Apple the fill-in below has nothing to fill.
  const bool hole = !fullyReserved("old");
#ifdef __ANDROID__
  CHECK(hole);
#endif
  if (!hole) std::printf("  (no hole: this file system backs small files fully; the fill-in is not tested here)\n");
  {
    zn::FlowStore fs(kFsDir, 8192);
    CHECK(fs.read("old").payload == "first");
    CHECK(fs.write("old", "second"));
    CHECK(fullyReserved("old"));
  }
  {
    zn::FlowStore fs(kFsDir, 8192);
    CHECK(fs.read("old").payload == "second");
  }

  // A full disk, faked with a file size limit (the kernel answers EFBIG where a full disk answers ENOSPC).
  rlimit before{};
  getrlimit(RLIMIT_FSIZE, &before);
  signal(SIGXFSZ, SIG_IGN);
  rlimit small = before;
  small.rlim_cur = 12 * 1024;
  CHECK(setrlimit(RLIMIT_FSIZE, &small) == 0);
  {
    zn::FlowStore fs(kFsDir, 8192);
    std::string err;
    // A new key can't get its file: the write fails, no crash, and the key still reads as missing (not broken).
    CHECK(!fs.write("nospace", "x", &err) && !err.empty());
    CHECK(fs.read("nospace").status == zn::FlowStore::ReadStatus::Missing);
    // Growing can't get its file: the write fails and the good state stays.
    err.clear();
    CHECK(!fs.write("old", std::string(40 * 1024, 'c'), &err) && !err.empty());
    CHECK(fs.read("old").payload == "second");
    // A write that fits the reserved file still works on the "full" disk: this is the payment-time write.
    CHECK(fs.write("old", "third"));
    CHECK(fs.read("old").payload == "third");
  }
  CHECK(setrlimit(RLIMIT_FSIZE, &before) == 0);
  signal(SIGXFSZ, SIG_DFL);
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
  testNativeCall();
  testUtf8();
  testStorage();
  testStorageKill();
  testFlowStoreBasics();
  testFlowStoreDamage();
  testFlowStoreGrowth();
  testFlowStoreThroughRuntime();
  testFlowStoreKill();
  testFlowStoreReserve();
  testTickAndApply();
  testNoOpsNoRequest();
  testTimers();
  std::printf("\n%d checks, %d failed\n", g_checks, g_failed);
  std::printf(g_failed == 0 ? "ALL PASSED\n" : "FAILED\n");
  return g_failed == 0 ? 0 : 1;
}
