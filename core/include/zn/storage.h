// App key-value storage (ARCHITECTURE §13.1, docs/storage.md), built on MMKV (vendored in third_party/mmkv).
//
// - Synchronous, on the JS thread: MMKV reads and writes are memory operations on a mapped file (microseconds), so JS
//   gets plain values back, not Promises.
// - Several stores, each a pair of files named by its id ("zn.default", "settings", ...) in one folder.
// - Values are stored as tagged blobs so a value always comes back with the type it was saved with:
//     [u8 type][payload]   type 1 string (UTF-8), 2 number (float64, little-endian), 3 boolean (1 byte), 4 bytes.
//   Keep this format stable: it is on users' phones. Native code that reads the same store must use it too.
// - A damaged file (power loss or a kill in the middle of a write) is dropped: the store opens empty. MMKV's "recover"
//   mode returned value bytes as keys in our kill test (docs/storage.md §4).
// - One Storage is not thread-safe (its map of open stores). Several Storage objects can share stores: MMKV keeps one
//   instance per store per process, with its own lock (the JS runtime and Kotlin's ZnStorage each have one).
#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

class MMKV;  // third_party/mmkv; kept out of this header

namespace zn {

enum class StoredType : uint8_t { String = 1, Number = 2, Boolean = 3, Bytes = 4 };

class Storage {
 public:
  using Log = std::function<void(int level, std::string_view message)>;  // level as in Platform::log

  // `rootDir` must exist. The first Storage of the process sets MMKV's global root and log handler.
  Storage(std::string rootDir, Log log);
  ~Storage();  // stops MMKV's log going to this runtime's platform (a `zn dev` reload makes a new one)

  // A store id: 1–64 characters from [A-Za-z0-9._-] (it becomes a file name).
  static bool validId(std::string_view id);

  bool set(std::string_view id, std::string_view key, std::span<const uint8_t> tagged);
  // The tagged blob, or nullopt if the key is missing.
  std::optional<std::vector<uint8_t>> get(std::string_view id, std::string_view key);
  bool has(std::string_view id, std::string_view key);
  bool remove(std::string_view id, std::string_view key);
  std::vector<std::string> keys(std::string_view id);
  void clear(std::string_view id);
  // Forces the store's file to flash (msync). Writes already survive a killed process; this makes them survive a
  // power cut too. Takes milliseconds.
  void flush(std::string_view id);

 private:
  MMKV* open(std::string_view id);

  std::string root_;
  std::unordered_map<std::string, MMKV*> open_;  // MMKV owns the instances; they live for the whole process
};

}  // namespace zn
