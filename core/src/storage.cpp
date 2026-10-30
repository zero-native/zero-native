#include "zn/storage.h"

#include <MMKV/MMKV.h>
#include <MMKV/MMKVHandler.h>

#include <mutex>
#include <string>
#include <utility>

namespace zn {
namespace {

// MMKV has one handler for the whole process. It sends MMKV's warnings to our log and turns a damaged file into a
// recovery instead of MMKV's default, which is to throw all data of that store away.
class Handler final : public mmkv::MMKVHandler {
 public:
  void setLog(const void* owner, Storage::Log log) {
    std::lock_guard<std::mutex> lock(mutex_);
    owner_ = owner;
    log_ = std::move(log);
  }

  void clearLog(const void* owner) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (owner_ != owner) return;  // another Storage (the Kotlin one, a newer runtime) set it since
    owner_ = nullptr;
    log_ = nullptr;
  }

  void mmkvLog(MMKVLogLevel level, const char*, int, const char*, MMKVLog_t message) override {
    const int ours = level >= MMKVLogError ? 3 : 2;
    std::lock_guard<std::mutex> lock(mutex_);
    if (log_) log_(ours, "storage (MMKV): " + std::string(message));
  }

  MMKVRecoverStrategic onMMKVCRCCheckFail(const std::string& id) override {
    mmkvLog(MMKVLogError, "", 0, "", "store \"" + id + "\" failed its checksum (damaged by a kill or power loss); its data is dropped");
    return OnErrorDiscard;
  }

  MMKVRecoverStrategic onMMKVFileLengthError(const std::string& id) override {
    mmkvLog(MMKVLogError, "", 0, "", "store \"" + id + "\" has a bad length (damaged by a kill or power loss); its data is dropped");
    return OnErrorDiscard;
  }

 private:
  std::mutex mutex_;
  const void* owner_ = nullptr;
  Storage::Log log_;
};

Handler& handler() {
  static Handler* h = new Handler();  // never destroyed: MMKV may log while the process exits
  return *h;
}

}  // namespace

Storage::Storage(std::string rootDir, Log log) : root_(std::move(rootDir)) {
  if (log) handler().setLog(this, std::move(log));
  // Only the first call in a process does anything (MMKV keeps one global root); every store passes root_ anyway.
  MMKV::initializeMMKV(root_, MMKVLogWarning, &handler());
}

Storage::~Storage() { handler().clearLog(this); }

bool Storage::validId(std::string_view id) {
  if (id.empty() || id.size() > 64) return false;
  for (const char c : id) {
    const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' ||
                    c == '_' || c == '-';
    if (!ok) return false;
  }
  return true;
}

MMKV* Storage::open(std::string_view id) {
  const std::string key(id);
  auto it = open_.find(key);
  if (it != open_.end()) return it->second;
  MMKV* kv = MMKV::mmkvWithID(key, MMKV_SINGLE_PROCESS, nullptr, &root_);
  if (kv != nullptr) open_.emplace(key, kv);
  return kv;
}

bool Storage::set(std::string_view id, std::string_view key, std::span<const uint8_t> tagged) {
  MMKV* kv = open(id);
  if (kv == nullptr) return false;
  // MMKV copies the bytes into its file; the buffer only needs to live for this call.
  mmkv::MMBuffer value(const_cast<uint8_t*>(tagged.data()), tagged.size(), mmkv::MMBufferNoCopy);
  return kv->set(value, key);
}

std::optional<std::vector<uint8_t>> Storage::get(std::string_view id, std::string_view key) {
  MMKV* kv = open(id);
  if (kv == nullptr) return std::nullopt;
  mmkv::MMBuffer value;
  if (!kv->getBytes(key, value)) return std::nullopt;
  const auto* p = static_cast<const uint8_t*>(value.getPtr());
  return std::vector<uint8_t>(p, p + value.length());
}

bool Storage::has(std::string_view id, std::string_view key) {
  MMKV* kv = open(id);
  return kv != nullptr && kv->containsKey(key);
}

bool Storage::remove(std::string_view id, std::string_view key) {
  MMKV* kv = open(id);
  return kv != nullptr && kv->removeValueForKey(key);
}

std::vector<std::string> Storage::keys(std::string_view id) {
  MMKV* kv = open(id);
  return kv != nullptr ? kv->allKeys() : std::vector<std::string>{};
}

void Storage::clear(std::string_view id) {
  if (MMKV* kv = open(id)) kv->clearAll();
}

void Storage::flush(std::string_view id) {
  if (MMKV* kv = open(id)) kv->sync(MMKV_SYNC);
}

}  // namespace zn
